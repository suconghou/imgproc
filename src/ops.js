/**
 * image-engine · 操作管线（环境无关）
 *
 * 本文件不依赖任何浏览器 / Node 专有 API，可运行在主线程、Web Worker 与 Node 中。
 * 它只做一件事：把「源字节 + 操作列表 + 输出选项」翻译成一条 libvips 管线，
 * 然后让 libvips 流式执行、一次性产出目标字节。
 *
 * 设计要点：整条管线只在 vips 内部构建图，不产生中间文件、不发生中间编解码，
 * 直到 writeToBuffer 才真正开始计算。这是 wasm-vips 快且省内存的根源。
 */

/* ────────────────────────────── 格式 ────────────────────────────── */

/** 可写出的格式 → MIME 类型 */
export const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tiff: 'image/tiff',
  jxl: 'image/jxl',
}

/** 可写出的格式 → libvips 写盘后缀 */
const SUFFIX_BY_FORMAT = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
  tiff: '.tif',
  jxl: '.jxl',
}

/** 支持产出的格式清单 */
export const OUTPUT_FORMATS = Object.keys(SUFFIX_BY_FORMAT)

/** 引擎错误：带稳定 code，便于调用方分支处理而不必解析文案 */
export class EngineError extends Error {
  constructor(message, code = 'ENGINE_ERROR') {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

/**
 * 把用户写的格式名归一化。
 * 'jpeg' / 'jpg' / '.JPG' / 'image/jpeg' → 'jpeg'
 */
export function normalizeFormat(value) {
  if (!value) return null
  const s = String(value).trim().toLowerCase().replace(/^image\//, '').replace(/^\./, '')
  if (s === 'jpg' || s === 'jpe') return 'jpeg'
  if (s === 'tif') return 'tiff'
  return s
}

/**
 * 用 magic bytes 嗅探输入格式（不依赖 libvips）。
 * 仅用于「调用方没指定输出格式时，保持原格式」。无法识别返回 null。
 */
export function sniffFormat(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp'
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00)
  ) return 'tiff'
  // ISO-BMFF（avif / heif / jxl 容器）：....ftyp<brand>
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1') return 'heif'
    if (brand === 'jxl ') return 'jxl'
  }
  // JPEG XL 原生码流
  if (bytes[0] === 0xff && bytes[1] === 0x0a) return 'jxl'
  return null
}

/* ────────────────────────────── 工具 ────────────────────────────── */

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** 不含 alpha 通道的输出格式：存这些格式前必须先把透明区合成到背景色 */
const FORMATS_WITHOUT_ALPHA = new Set(['jpeg'])

/** 支持多帧（动图）输出的格式 */
const ANIMATED_FORMATS = new Set(['gif', 'webp', 'avif'])

/** 可以用「二分 quality」逼近目标体积的有损格式（webp 走原生 target_size，不在此列） */
const BISECT_FORMATS = new Set(['jpeg', 'avif', 'jxl'])

/** 图像是否带 alpha（2=灰度+alpha，4=RGBA） */
const hasAlphaBands = (img) => img.bands === 2 || img.bands === 4

/**
 * 解析背景色：'#rgb' / '#rrggbb' / 'white' 等 CSS 色名 / [r,g,b] → [r,g,b]（0-255）
 */
const NAMED_COLORS = { white: [255, 255, 255], black: [0, 0, 0] }
export function parseColor(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return [clampInt(value[0], 0, 255, 255), clampInt(value[1], 0, 255, 255), clampInt(value[2], 0, 255, 255)]
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (NAMED_COLORS[s]) return NAMED_COLORS[s]
    const hex = s.startsWith('#') ? s.slice(1) : s
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)]
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    }
  }
  return NAMED_COLORS.white
}

/** flatten 的背景值长度必须与「图像波段数 - 1」一致：RGBA 给 3 个，灰度+alpha 给 1 个 */
const backgroundFor = (bands, rgb) => (bands === 2 ? [rgb[0]] : rgb)

/**
 * 解析目标体积：数字（字节），或 '200kb' / '1.5mb' / '80KB' 这类字符串
 */
export function parseByteSize(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return value > 0 ? Math.round(value) : 0
  const m = String(value).trim().toLowerCase().match(/^([\d.]+)\s*(b|kb|k|mb|m)?$/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return 0
  const unit = m[2] || 'b'
  const factor = unit === 'mb' || unit === 'm' ? 1024 * 1024 : unit === 'b' ? 1 : 1024
  return Math.round(n * factor)
}


/** 构建某个输出格式对应的 libvips 保存选项 */
export function buildSaveOptions(format, output = {}) {
  const q = output.quality
  const keep = output.keepMetadata ? 'all' : 'none'
  const opts = {}

  switch (format) {
    case 'jpeg':
      Object.assign(opts, {
        Q: clampInt(q, 1, 100, 85),
        optimize_coding: true,
        interlace: output.progressive === true,
        subsample_mode: output.chromaSubsampling ?? 'auto',
        keep,
      })
      break

    case 'png':
      Object.assign(opts, {
        compression: clampInt(output.compressionLevel, 0, 9, 6),
        interlace: output.progressive === true,
        keep,
      })
      // PNG 本身无损，quality 只在「转调色板」时才有意义
      if (output.palette === true) {
        Object.assign(opts, { palette: true, Q: clampInt(q, 1, 100, 80), effort: clampInt(output.effort, 1, 10, 7) })
      }
      break

    case 'webp': {
      const target = parseByteSize(output.targetSize)
      Object.assign(opts, {
        lossless: output.lossless === true,
        effort: clampInt(output.effort, 0, 6, 4),
        keep,
      })
      if (target > 0 && output.lossless !== true) {
        // libwebp 原生支持按目标体积编码，最精确也最快（此时 Q 会被忽略）
        opts.target_size = target
        opts.passes = clampInt(output.passes, 1, 10, 6)
      } else {
        opts.Q = clampInt(q, 1, 100, 80)
      }
      break
    }

    case 'avif':
      Object.assign(opts, {
        Q: clampInt(q, 1, 100, 60),
        effort: clampInt(output.effort, 0, 9, 4),
        lossless: output.lossless === true,
        compression: 'av1',
        keep,
      })
      break

    case 'gif':
      Object.assign(opts, {
        effort: clampInt(output.effort, 1, 10, 7),
        interlace: output.progressive === true,
        keep,
      })
      break

    case 'jxl':
      Object.assign(opts, {
        Q: clampInt(q, 1, 100, 80),
        effort: clampInt(output.effort, 1, 9, 5),
        lossless: output.lossless === true,
        keep,
      })
      break

    case 'tiff':
      Object.assign(opts, {
        compression: output.lossless === false ? 'jpeg' : 'deflate',
        Q: clampInt(q, 1, 100, 85),
        keep,
      })
      break
  }

  // 逃生舱：任何 libvips 原生保存选项都可以从这里直接透传
  if (output.options && typeof output.options === 'object') Object.assign(opts, output.options)
  return opts
}

/* ────────────────────────────── 单步操作 ────────────────────────────── */

/** 通用缩放：把 resize 语义翻译成 libvips 的 resize + crop */
function applyResize(img, step) {
  const fit = step.fit || 'inside'
  const kernel = step.kernel || 'lanczos3'
  const width = step.width ? Math.max(1, Math.round(step.width)) : 0
  const height = step.height ? Math.max(1, Math.round(step.height)) : 0
  const iw = img.width
  const ih = img.height

  let sx
  let sy
  if (width && height) {
    const fx = width / iw
    const fy = height / ih
    if (fit === 'cover') { sx = sy = Math.max(fx, fy) }
    else if (fit === 'fill') { sx = fx; sy = fy }
    else { sx = sy = Math.min(fx, fy) } // inside
  } else if (width) {
    sx = sy = width / iw
  } else {
    sx = sy = height / ih
  }

  if (step.upscale !== true) {
    if (fit === 'fill') {
      sx = Math.min(sx, 1)
      sy = Math.min(sy, 1)
    } else {
      const s = Math.min(sx, sy)
      if (s > 1) sx = sy = 1
    }
  }

  let out = img.resize(sx, { kernel, vscale: sy })

  if (fit === 'cover' && width && height) {
    const cw = Math.min(width, out.width)
    const ch = Math.min(height, out.height)
    out = out.crop(Math.round((out.width - cw) / 2), Math.round((out.height - ch) / 2), cw, ch)
  }
  return out
}

/** 执行单个操作步骤 */
function applyStep(img, step) {
  const op = step.op || step.operation
  switch (op) {
    case 'autorot':
      return img.autorot()

    case 'resize':
      return applyResize(img, step)

    case 'crop': {
      const left = Math.max(0, Math.round(step.left ?? 0))
      const top = Math.max(0, Math.round(step.top ?? 0))
      const w = Math.round(step.width ?? 0)
      const h = Math.round(step.height ?? 0)
      if (!w || !h) throw new EngineError('crop 必须提供正的 width 与 height', 'BAD_OP')
      if (left + w > img.width || top + h > img.height) {
        throw new EngineError(
          `crop 区域 (${left},${top},${w},${h}) 超出图像边界 ${img.width}×${img.height}`,
          'OUT_OF_BOUNDS',
        )
      }
      return img.crop(left, top, w, h)
    }

    case 'rotate': {
      const angle = ((Math.round(Number(step.angle ?? 0)) % 360) + 360) % 360
      if (angle === 0) return img
      if (angle === 90) return img.rot90()
      if (angle === 180) return img.rot180()
      if (angle === 270) return img.rot270()
      throw new EngineError('rotate 只支持 0 / 90 / 180 / 270 度', 'BAD_OP')
    }

    // flip: 上下翻转；flop: 左右翻转
    case 'flip':
      return img.flipVer()
    case 'flop':
      return img.flipHor()

    // 把透明区合成到指定背景色（无色可合则原样返回）
    case 'flatten': {
      if (!hasAlphaBands(img)) return img
      const rgb = parseColor(step.background ?? '#ffffff')
      return img.flatten({ background: backgroundFor(img.bands, rgb) })
    }

    default:
      throw new EngineError(
        `未知操作 "${op}"，可选：autorot / resize / crop / rotate / flip / flop / flatten`,
        'BAD_OP',
      )
  }
}

/* ────────────────────────────── 快速路径 ────────────────────────────── */

/**
 * 首个操作就是 resize 时，可走 libvips 的 thumbnail 快速路径：
 * 它能在「解码阶段」就按目标尺寸采样（JPEG 尤其明显），比先全量解码再缩放快得多。
 * 返回传给 thumbnailBuffer 的参数；不适用则返回 null。
 */
function thumbnailArgs(step, autorotate) {
  const fit = step.fit || 'inside'
  if (fit !== 'inside' && fit !== 'cover' && fit !== 'fill') return null
  if (!step.width) return null // thumbnailBuffer 必须给 width
  const width = Math.max(1, Math.round(step.width))
  const height = step.height ? Math.max(1, Math.round(step.height)) : undefined
  if (fit === 'fill' && !height) return null

  const options = { no_rotate: autorotate === false }
  if (fit === 'fill') {
    options.size = 'force'
    options.height = height
  } else {
    options.size = step.upscale === true ? 'both' : 'down'
    if (height) {
      options.height = height
      // cover = 先填满矩形再居中裁剪
      if (fit === 'cover') options.crop = 'centre'
    }
  }
  return { width, options }
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

/**
 * 执行完整管线。
 *
 * @param {object} vips      已初始化的 wasm-vips 模块
 * @param {Uint8Array} input 源图片字节
 * @param {Array} ops        操作列表，按顺序执行
 * @param {object} output    输出选项（format / quality / targetSize / animated / background / flatten / ...）
 * @param {object} [control] 运行时挂钩：onProgress(percent)，在**当前线程**内同步回调
 * @returns {{buffer: Uint8Array, width: number, height: number, frameHeight: number,
 *            frames: number, quality: number|null|undefined, format: string, mime: string}}
 */
export function runPipeline(vips, input, ops = [], output = {}, control = {}) {
  const steps = Array.isArray(ops) ? ops : ops ? [ops] : []

  const sourceFormat = sniffFormat(input)
  const requested = normalizeFormat(output.format)
  const format = requested || sourceFormat || 'jpeg'
  if (!SUFFIX_BY_FORMAT[format]) {
    if (format === 'heic' || format === 'heif') {
      throw new EngineError(
        '无法输出 HEIC/HEIF：WASM 包未包含 HEVC 编码器（专利限制）。可改用 avif / webp / jpeg。',
        'UNSUPPORTED_FORMAT',
      )
    }
    throw new EngineError(
      `不支持的输出格式 "${output.format}"，可选：${OUTPUT_FORMATS.join(' / ')}`,
      'UNSUPPORTED_FORMAT',
    )
  }

  const suffix = SUFFIX_BY_FORMAT[format]
  const autorotate = output.autorotate !== false
  const userHasAutorot = steps.some((s) => (s?.op || s?.operation) === 'autorot')

  /* ── 目标体积 ─────────────────────────────────────────────── */
  const targetBytes = parseByteSize(output.targetSize)
  const nativeTarget = targetBytes > 0 && format === 'webp' && output.lossless !== true
  const bisectTarget = targetBytes > 0 && !nativeTarget && BISECT_FORMATS.has(format)
  if (targetBytes > 0 && !nativeTarget && !bisectTarget) {
    throw new EngineError(
      `targetSize 不支持 ${format}：无损格式无法按体积收敛。目前只对 webp / jpeg / avif / jxl 生效。`,
      'UNSUPPORTED_OPTION',
    )
  }

  /* ── 动图 ─────────────────────────────────────────────────── */
  const animated = output.animated === true
  if (animated) {
    if (!ANIMATED_FORMATS.has(format)) {
      throw new EngineError(
        `animated: true 只支持 gif / webp / avif 输出，当前是 ${format}`,
        'UNSUPPORTED_OPTION',
      )
    }
    const unsupported = steps.find((s) => {
      const op = s?.op || s?.operation
      return op && op !== 'resize' && op !== 'autorot' && op !== 'flatten'
    })
    if (unsupported) {
      throw new EngineError(
        `animated: true 时只允许 resize（可附带 autorot / flatten）——当前还带了 `
        + `"${unsupported.op || unsupported.operation}"，裁剪 / 旋转会破坏多帧结构。`
        + '只处理单帧请显式传 animated: false。',
        'UNSUPPORTED_OPTION',
      )
    }
  }

  /* ── 透明合成 ─────────────────────────────────────────────── */
  // 目标格式不含 alpha（目前只有 jpeg）时必须先合成到背景色，
  // 否则 libvips 会按黑底合成 —— 透明 logo 转 JPEG 会得到黑底图。
  const autoFlatten = FORMATS_WITHOUT_ALPHA.has(format) && output.flatten !== false
  const explicitFlatten = steps.some((s) => (s?.op || s?.operation) === 'flatten')
  const background = parseColor(output.background ?? '#ffffff')

  const created = []
  const track = (im) => { created.push(im); return im }

  try {
    let img = null
    let rest = steps

    // 快速路径：首个操作就是 resize 时交给 libvips thumbnail，
    // 它在解码阶段就按目标尺寸采样（JPEG 尤其明显），比先全量解码再缩放快得多。
    const first = steps[0]
    if (first && (first.op || first.operation) === 'resize') {
      const fast = thumbnailArgs(first, autorotate)
      if (fast) {
        if (animated) fast.options.option_string = 'n=-1' // 多帧：让底层 loader 载入全部帧
        img = track(vips.Image.thumbnailBuffer(input, fast.width, fast.options))
        rest = steps.slice(1)
      }
    }

    if (!img) {
      // 'n=-1' 是 loader 的选项串：多帧格式（gif / webp / avif）由此载入全部帧
      img = track(animated ? vips.Image.newFromBuffer(input, 'n=-1') : vips.Image.newFromBuffer(input))
      if (autorotate && !userHasAutorot) img = track(img.autorot())
    }

    for (const step of rest) {
      if (!step) continue
      const next = applyStep(img, step)
      if (next && next !== img) img = track(next)
    }

    if (autoFlatten && !explicitFlatten && hasAlphaBands(img)) {
      img = track(img.flatten({ background: backgroundFor(img.bands, background) }))
    }

    const width = img.width
    const height = img.height
    let frameHeight = height
    try { if (img.pageHeight > 0) frameHeight = img.pageHeight } catch { /* 无 page-height 视为单帧 */ }
    const frames = frameHeight > 0 ? Math.max(1, Math.round(height / frameHeight)) : 1

    // 进度：libvips 在求值过程中回调本函数，这里折成 0-100 的整数变化再上报
    if (typeof control.onProgress === 'function') {
      const report = control.onProgress
      let last = -1
      img.onProgress = (percent) => {
        const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
        if (p === last) return
        last = p
        try { report(p) } catch { /* 调用方回调抛错不应影响处理 */ }
      }
    }

    const withPage = (o) => {
      if (animated && frameHeight > 0) o.page_height = frameHeight
      return o
    }

    let quality = output.quality
    let raw
    if (bisectTarget) {
      // 二分 quality 逼近目标体积。只记下命中的 quality、最后重编一次，
      // 避免在多次编码之间持有 WASM 堆上的视图（内存会被复用）。
      let lo = 1
      let hi = 100
      let best = 0
      for (let i = 0; i < 7 && lo <= hi; i++) {
        const q = Math.round((lo + hi) / 2)
        const size = img.writeToBuffer(
          suffix,
          withPage(buildSaveOptions(format, { ...output, targetSize: undefined, quality: q })),
        ).byteLength
        if (size <= targetBytes) {
          best = q
          lo = q + 1
          if (size >= targetBytes * 0.92) break // 已经贴着目标，收手
        } else {
          hi = q - 1
        }
      }
      quality = best > 0 ? best : 1
      raw = img.writeToBuffer(
        suffix,
        withPage(buildSaveOptions(format, { ...output, targetSize: undefined, quality })),
      )
    } else {
      if (nativeTarget) quality = null // libwebp 自己决定，Q 被忽略
      raw = img.writeToBuffer(suffix, withPage(buildSaveOptions(format, output)))
    }

    // 立刻复制成独立内存：raw 可能是 WASM 堆上的视图，
    // 一旦下面的 finally 释放了图像，堆内存就会被复用。
    const buffer = raw.slice()

    return {
      buffer,
      width,
      height,
      frameHeight,
      frames,
      quality,
      format,
      mime: MIME_BY_FORMAT[format],
    }
  } finally {
    for (const im of created) {
      try { if (im && !im.isDeleted?.()) im.delete?.() } catch { /* 忽略释放期异常 */ }
    }
  }
}

/**
 * 只读取元信息，不做任何像素计算（vips 懒执行，读 header 极快）。
 * 用 'n=-1' 载入全部帧，否则多帧格式（gif / webp / avif）只能看到第一帧，
 * pages 会恒为 1。loader 只解析帧头、不解码像素，代价可控。
 */
export function readMetadata(vips, input) {
  let img
  try {
    img = vips.Image.newFromBuffer(input, 'n=-1')
  } catch {
    img = vips.Image.newFromBuffer(input)
  }
  try {
    let pages = 1
    let frameHeight = img.height
    try {
      if (img.pageHeight > 0) {
        frameHeight = img.pageHeight
        pages = Math.max(1, Math.round(img.height / frameHeight))
      }
    } catch { /* 部分格式没有 page-height，忽略 */ }
    return {
      width: img.width,
      height: img.height,
      frameHeight,
      bands: img.bands,
      hasAlpha: img.hasAlpha(),
      pixelFormat: img.format,
      interpretation: img.interpretation,
      pages,
      animated: pages > 1,
      sourceFormat: sniffFormat(input),
    }
  } finally {
    try { img.delete?.() } catch { /* 忽略 */ }
  }
}
