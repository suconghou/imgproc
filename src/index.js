/**
 * image-engine · 对外主入口
 *
 *   import { createImageEngine } from './image-engine/index.js'
 *   const engine = await createImageEngine()
 *   const out = await engine.process(file, [{ op: 'resize', width: 1200 }], { format: 'webp', quality: 80 })
 *
 * 浏览器里会自动起一个 Web Worker 池，像素运算全在后台线程完成，主线程不卡。
 * 在没有 Worker 的环境（Node / Deno / 老浏览器）自动退化为直连模式，API 完全一致。
 */

import { runPipeline, readMetadata, EngineError, MIME_BY_FORMAT, OUTPUT_FORMATS } from './ops.js'
import { loadVips, isNodeEnvironment } from './loader.js'

export { EngineError, MIME_BY_FORMAT, OUTPUT_FORMATS } from './ops.js'

/** 默认最多起几个 Worker */
const DEFAULT_MAX_WORKERS = 4

/** 运行时能力探测 */
export function isSupported() {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
}

/* ─────────────────────────── 输入 / 输出归一化 ─────────────────────────── */

/** 把各种来源统一成 Uint8Array */
async function toBytes(source) {
  if (source == null) throw new EngineError('输入为空', 'BAD_INPUT')
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer())
  if (typeof source.arrayBuffer === 'function') return new Uint8Array(await source.arrayBuffer())
  if (typeof source === 'string') throw new EngineError('请传入 File/Blob/ArrayBuffer/Uint8Array，而不是路径字符串', 'BAD_INPUT')
  throw new EngineError('不支持的输入类型，请传 File / Blob / ArrayBuffer / Uint8Array', 'BAD_INPUT')
}

/**
 * 复制成独立 ArrayBuffer 以便 transfer。
 * 不能直接把 input.buffer 交出去：它可能是 Buffer 的共享内存池或某个子视图。
 */
function toTransferable(bytes) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/** 统一结果对象 */
function normalizeResult(payload) {
  const buffer = new Uint8Array(payload.buffer)
  const mime = payload.mime || MIME_BY_FORMAT[payload.format] || 'application/octet-stream'
  const frames = payload.frames ?? 1
  return {
    buffer,
    blob: typeof Blob !== 'undefined' ? new Blob([buffer], { type: mime }) : null,
    width: payload.width,
    height: payload.height,
    /** 单帧高度；多帧时 height 是所有帧拼起来的总高度 */
    frameHeight: payload.frameHeight ?? payload.height,
    /** 帧数；> 1 表示动图 */
    frames,
    animated: frames > 1,
    /** 实际使用的 quality；webp 走 targetSize 时为 null（Q 被忽略），未指定时为 undefined */
    quality: payload.quality,
    size: buffer.byteLength,
    format: payload.format,
    mime,
    type: mime,
  }
}

/**
 * 去掉 output 里不能跨线程传递的成员（函数）。
 * onProgress 只在主线程持有，靠任务 id 把 Worker 的进度消息路由回来。
 */
function stripControl(output) {
  if (!output || typeof output !== 'object') return {}
  const clean = {}
  for (const [k, v] of Object.entries(output)) {
    if (typeof v !== 'function') clean[k] = v
  }
  return clean
}

/** 还原 Worker 侧序列化过来的错误 */
function deserializeError(err) {
  if (!err) return new EngineError('未知错误', 'UNKNOWN')
  const e = new EngineError(err.message || '未知错误', err.code || 'ENGINE_ERROR')
  e.name = err.name || 'EngineError'
  if (err.stack) e.stack = err.stack
  return e
}

/* ─────────────────────────── API 组装 ─────────────────────────── */

function buildApi({ mode, size, run, meta, destroy }) {
  const api = {
    /** 'worker' | 'direct' */
    mode,
    /** Worker 池大小（直连模式恒为 1） */
    size,

    /**
     * 核心方法：按 ops 依次处理，再按 output 编码。
     * @param {File|Blob|ArrayBuffer|Uint8Array} source
     * @param {Array} ops         操作列表
     * @param {object} output     输出选项（format / quality / targetSize / animated / background / onProgress …）
     * @param {object} [control]  { signal } —— AbortSignal，用于中途取消
     */
    process(source, ops, output, control) {
      return run(source, ops, output, control)
    },

    /** 语法糖：只缩放 */
    resize(source, { output, control, ...op } = {}) {
      return run(source, [{ op: 'resize', ...op }], output || {}, control)
    },

    /** 语法糖：只裁剪 */
    crop(source, { output, control, ...op } = {}) {
      return run(source, [{ op: 'crop', ...op }], output || {}, control)
    },

    /** 语法糖：只转格式（不改尺寸） */
    convert(source, output = {}, control) {
      return run(source, [], output, control)
    },

    /** 读取元信息（不解码像素） */
    metadata(source) {
      return meta(source)
    },

    /** 释放资源 */
    destroy,
  }
  return api
}

/* ─────────────────────────── 直连引擎（Node / 无 Worker） ─────────────────────────── */

async function createDirectEngine(options, config) {
  const vips = await loadVips({
    svg: config.svg,
    wasmBase: config.wasmBase,
    locateFile: options.locateFile,
    threads: config.threads,
  })

  let destroyed = false
  const assertAlive = () => {
    if (destroyed) throw new EngineError('引擎已销毁，请重新 createImageEngine()', 'DESTROYED')
  }

  const api = buildApi({
    mode: 'direct',
    size: 1,
    async run(source, ops, output, control) {
      assertAlive()
      const signal = control?.signal
      if (signal?.aborted) throw new EngineError('已取消', 'ABORTED')
      const bytes = await toBytes(source)
      if (signal?.aborted) throw new EngineError('已取消', 'ABORTED')
      // 直连模式下 runPipeline 是同步的，中途无法被打断，
      // signal 只能在此处（开始前）生效。
      return normalizeResult(runPipeline(vips, bytes, ops, output, { onProgress: output?.onProgress }))
    },
    async meta(source) {
      assertAlive()
      return readMetadata(vips, await toBytes(source))
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      try { vips.shutdown?.() } catch { /* 忽略 */ }
    },
  })
  return api
}

/* ─────────────────────────── Worker 池引擎（浏览器） ─────────────────────────── */

function createSlot(workerUrl) {
  const worker = new Worker(workerUrl, { type: 'module' })
  const pending = new Map()
  let seq = 0

  const slot = {
    busy: false,
    dead: false,
    worker,

    /**
     * @param {object} message 发给 Worker 的消息（自动补 id）
     * @param {object} [options] { transfer, onProgress }
     */
    call(message, options = {}) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress: options.onProgress })
        worker.postMessage({ ...message, id }, options.transfer || [])
      })
    },

    terminate(reason) {
      slot.dead = true
      worker.terminate()
      const err = reason || new EngineError('引擎已销毁', 'DESTROYED')
      for (const entry of pending.values()) entry.reject(err)
      pending.clear()
    },
  }

  worker.onmessage = (event) => {
    const msg = event.data
    if (!msg || !msg.id) return
    const entry = pending.get(msg.id)
    if (!entry) return
    // 进度是「进行中」的通知，不能因此结束该任务的等待
    if (msg.type === 'progress') {
      try { entry.onProgress?.(msg.percent) } catch { /* 调用方回调抛错不影响任务 */ }
      return
    }
    pending.delete(msg.id)
    if (typeof msg.type === 'string' && msg.type.endsWith('error')) entry.reject(deserializeError(msg.error))
    else entry.resolve(msg)
  }

  worker.onerror = (event) => {
    const err = new EngineError(event?.message || 'Worker 内部错误', 'WORKER_ERROR')
    for (const entry of pending.values()) entry.reject(err)
    pending.clear()
  }

  return slot
}

async function createWorkerEngine(options, config) {
  const workerUrl = options.workerUrl || new URL('./worker.js', import.meta.url)

  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2
  const requested = Number(options.workers)
  const size = Math.max(
    1,
    Math.min(Number.isFinite(requested) && requested > 0 ? requested : Math.min(cores, DEFAULT_MAX_WORKERS), 16),
  )

  // 池里有多个 Worker 时，每个只用 1 个 libvips 线程 —— 否则会线程超订。
  // 只有 1 个 Worker 时，让它吃满所有核更划算。
  const threadsPerWorker = config.threads > 0 ? config.threads : size === 1 ? cores : 1
  const initMessage = { type: 'init', config: { svg: config.svg, wasmBase: config.wasmBase, threads: threadsPerWorker } }

  const slots = []
  const waiters = []
  let destroyed = false

  /** 起一个 Worker 并等它把 vips 初始化好 */
  async function spawnSlot() {
    const slot = createSlot(workerUrl)
    try {
      await slot.call(initMessage)
    } catch (err) {
      slot.terminate(err)
      throw err
    }
    return slot
  }

  async function acquire() {
    if (destroyed) throw new EngineError('引擎已销毁，请重新 createImageEngine()', 'DESTROYED')
    // 池被取消操作掏空时按需补一个，避免永远等不到名额
    if (slots.length === 0) {
      const fresh = await spawnSlot()
      fresh.busy = true
      slots.push(fresh)
      return fresh
    }
    const free = slots.find((s) => !s.busy)
    if (free) {
      free.busy = true
      return free
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }

  function release(slot) {
    if (slot.dead || destroyed) return
    const next = waiters.shift()
    if (next) next.resolve(slot) // 名额直接转交给下一个等待者，slot 保持 busy
    else slot.busy = false
  }

  /**
   * 取消一个正在跑的任务：Worker 里是同步的 WASM 求值，
   * 发消息进去也不会被处理，所以只能终止它、再用一个新 Worker 补位。
   */
  function recycleSlot(slot, reason) {
    const i = slots.indexOf(slot)
    if (i >= 0) slots.splice(i, 1)
    slot.terminate(reason)
    if (destroyed) return
    spawnSlot()
      .then((fresh) => {
        const w = waiters.shift()
        if (w) {
          fresh.busy = true
          w.resolve(fresh)
        }
        slots.push(fresh)
      })
      .catch((err) => {
        // 补位失败：把错误交给一个等待者，避免它永远挂着
        const w = waiters.shift()
        if (w) w.reject(err)
      })
  }

  try {
    slots.push(...(await Promise.all(Array.from({ length: size }, () => spawnSlot()))))
  } catch (err) {
    slots.forEach((s) => s.terminate(err))
    throw err
  }

  const api = buildApi({
    mode: 'worker',
    size,
    async run(source, ops, output, control) {
      const signal = control?.signal
      if (signal?.aborted) throw new EngineError('已取消', 'ABORTED')

      const bytes = await toBytes(source)
      const slot = await acquire()
      let aborted = false

      const onAbort = () => {
        aborted = true
        recycleSlot(slot, new EngineError('已取消', 'ABORTED'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      try {
        if (signal?.aborted) throw new EngineError('已取消', 'ABORTED')
        const msg = await slot.call(
          {
            type: 'run',
            input: toTransferable(bytes),
            ops: ops || [],
            // 函数不能结构化克隆，onProgress 留在主线程，靠 msg.id 路由回来
            output: stripControl(output),
          },
          { onProgress: typeof output?.onProgress === 'function' ? output.onProgress : undefined },
        )
        return normalizeResult(msg)
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (!aborted) release(slot)
      }
    },
    async meta(source) {
      const bytes = await toBytes(source)
      const slot = await acquire()
      try {
        const msg = await slot.call({ type: 'metadata', input: toTransferable(bytes) })
        return msg.meta
      } finally {
        release(slot)
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      slots.forEach((s) => s.terminate())
      slots.length = 0
      // 让所有还在排队等 Worker 的调用立刻失败，而不是永远挂着
      const pendingWaiters = waiters.splice(0, waiters.length)
      for (const w of pendingWaiters) w.reject(new EngineError('引擎已销毁', 'DESTROYED'))
    },
  })
  return api
}

/* ─────────────────────────── 工厂 ─────────────────────────── */

/**
 * 创建一个图片处理引擎。
 *
 * @param {object} [options]
 * @param {number} [options.workers]     Worker 数量；0 表示不用 Worker（主线程直连）
 * @param {string} [options.workerUrl]   自定义 worker.js 地址（默认同目录）
 * @param {string} [options.wasmBase]    wasm 所在目录，默认与胶水代码同目录
 * @param {boolean}[options.svg]         启用 SVG 输入（需 vips-resvg.wasm）
 * @param {number} [options.threads]     libvips 内部线程数
 * @param {Function}[options.locateFile] 自定义 wasm 定位（仅直连模式生效）
 * @returns {Promise<object>} 引擎实例
 */
export async function createImageEngine(options = {}) {
  if (!isSupported()) {
    throw new EngineError('当前环境不支持 WebAssembly', 'UNSUPPORTED_ENV')
  }

  const config = {
    svg: options.svg === true,
    wasmBase: options.wasmBase || '',
    threads: Number.isFinite(options.threads) ? Number(options.threads) : 0,
  }

  const canUseWorker =
    typeof Worker !== 'undefined' &&
    !isNodeEnvironment() &&
    Number(options.workers) !== 0

  return canUseWorker
    ? createWorkerEngine(options, config)
    : createDirectEngine(options, config)
}
