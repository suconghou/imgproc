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
  return {
    buffer,
    blob: typeof Blob !== 'undefined' ? new Blob([buffer], { type: mime }) : null,
    width: payload.width,
    height: payload.height,
    size: buffer.byteLength,
    format: payload.format,
    mime,
    type: mime,
  }
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
     * @param {Array} ops      操作列表
     * @param {object} output  输出选项
     */
    process(source, ops, output) {
      return run(source, ops, output)
    },

    /** 语法糖：只缩放 */
    resize(source, options = {}) {
      return run(source, [{ op: 'resize', ...options }], options.output || {})
    },

    /** 语法糖：只裁剪 */
    crop(source, options = {}) {
      return run(source, [{ op: 'crop', ...options }], options.output || {})
    },

    /** 语法糖：只转格式（不改尺寸） */
    convert(source, output = {}) {
      return run(source, [], output)
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
    async run(source, ops, output) {
      assertAlive()
      const bytes = await toBytes(source)
      return normalizeResult(runPipeline(vips, bytes, ops, output))
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
    worker,

    call(message, transfer) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ ...message, id }, transfer || [])
      })
    },

    terminate() {
      worker.terminate()
      for (const entry of pending.values()) entry.reject(new EngineError('引擎已销毁', 'DESTROYED'))
      pending.clear()
    },
  }

  worker.onmessage = (event) => {
    const msg = event.data
    if (!msg || !msg.id) return
    const entry = pending.get(msg.id)
    if (!entry) return
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

  const slots = Array.from({ length: size }, () => createSlot(workerUrl))
  const waiters = []
  let destroyed = false

  function acquire() {
    if (destroyed) return Promise.reject(new EngineError('引擎已销毁，请重新 createImageEngine()', 'DESTROYED'))
    const free = slots.find((s) => !s.busy)
    if (free) {
      free.busy = true
      return Promise.resolve(free)
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }

  function release(slot) {
    const next = waiters.shift()
    if (next) next.resolve(slot) // 名额直接转交给下一个等待者，slot 保持 busy
    else slot.busy = false
  }

  const initMessage = { type: 'init', config: { svg: config.svg, wasmBase: config.wasmBase, threads: threadsPerWorker } }

  try {
    await Promise.all(slots.map((slot) => slot.call(initMessage)))
  } catch (err) {
    slots.forEach((s) => s.terminate())
    throw err
  }

  const api = buildApi({
    mode: 'worker',
    size,
    async run(source, ops, output) {
      const bytes = await toBytes(source)
      const slot = await acquire()
      try {
        const msg = await slot.call(
          { type: 'run', input: toTransferable(bytes), ops: ops || [], output: output || {} },
          undefined,
        )
        return normalizeResult(msg)
      } finally {
        release(slot)
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
