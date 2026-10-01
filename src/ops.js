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

    case 'webp':
      Object.assign(opts, {
        Q: clampInt(q, 1, 100, 80),
        lossless: output.lossless === true,
        effort: clampInt(output.effort, 0, 6, 4),
        keep,
      })
      break

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

    default:
      throw new EngineError(`未知操作 "${op}"，可选：autorot / resize / crop / rotate / flip / flop`, 'BAD_OP')
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
 * @param {object} vips    已初始化的 wasm-vips 模块
 * @param {Uint8Array} input 源图片字节
 * @param {Array} ops      操作列表，按顺序执行
 * @param {object} output  输出选项（format / quality / ...）
 * @returns {{buffer: Uint8Array, width: number, height: number, format: string, mime: string}}
 */
export function runPipeline(vips, input, ops = [], output = {}) {
  const steps = Array.isArray(ops) ? ops : ops ? [ops] : []

  const sourceFormat = sniffFormat(input)
  const requested = normalizeFormat(output.format)
  let format = requested || sourceFormat || 'jpeg'
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

  // EXIF 摆正：默认开启，可用 output.autorotate = false 关闭
  const autorotate = output.autorotate !== false
  // 调用方显式写了 autorot 步骤则不再重复插入
  const userHasAutorot = steps.some((s) => (s?.op || s?.operation) === 'autorot')

  const created = []
  const track = (im) => { created.push(im); return im }

  try {
    let img = null
    let rest = steps

    const first = steps[0]
    if (first && (first.op || first.operation) === 'resize') {
      const fast = thumbnailArgs(first, autorotate)
      if (fast) {
        img = track(vips.Image.thumbnailBuffer(input, fast.width, fast.options))
        rest = steps.slice(1)
      }
    }

    if (!img) {
      img = track(vips.Image.newFromBuffer(input))
      if (autorotate && !userHasAutorot) img = track(img.autorot())
    }

    for (const step of rest) {
      if (!step) continue
      const next = applyStep(img, step)
      if (next && next !== img) img = track(next)
    }

    const width = img.width
    const height = img.height
    const raw = img.writeToBuffer(SUFFIX_BY_FORMAT[format], buildSaveOptions(format, output))
    // 立刻复制成独立内存：raw 可能是 WASM 堆上的视图，
    // 一旦下面的 finally 释放了图像，堆内存就会被复用。
    const buffer = raw.slice()

    return { buffer, width, height, format, mime: MIME_BY_FORMAT[format] }
  } finally {
    for (const im of created) {
      try { if (im && !im.isDeleted?.()) im.delete?.() } catch { /* 忽略释放期异常 */ }
    }
  }
}

/**
 * 只读取元信息，不做任何像素计算（vips 懒执行，读 header 极快）。
 */
export function readMetadata(vips, input) {
  const img = vips.Image.newFromBuffer(input)
  try {
    let pages = 1
    try {
      if (img.pageHeight > 0) pages = Math.max(1, Math.round(img.height / img.pageHeight))
    } catch { /* 部分格式没有 page-height，忽略 */ }
    return {
      width: img.width,
      height: img.height,
      bands: img.bands,
      hasAlpha: img.hasAlpha(),
      pixelFormat: img.format,
      interpretation: img.interpretation,
      pages,
      sourceFormat: sniffFormat(input),
    }
  } finally {
    try { img.delete?.() } catch { /* 忽略 */ }
  }
}
