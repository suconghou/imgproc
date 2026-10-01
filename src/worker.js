/**
 * image-engine · Web Worker
 *
 * 只承担两件事：持有 vips 实例、把主线程的任务在后台线程里跑完。
 * 所有像素运算都发生在这里，主线程不会被阻塞。
 *
 * 协议（与 index.js 配对）：
 *   主 → Worker  { type: 'init',     id, config }
 *   主 → Worker  { type: 'run',      id, input, ops, output }
 *   主 → Worker  { type: 'metadata', id, input }
 *   Worker → 主  { type: 'ready'    | 'init-error', id, error? }
 *                { type: 'result'   | 'run-error',  id, ... }
 *                { type: 'metadata-result' | 'metadata-error', id, ... }
 */

import { loadVips } from './loader.js'
import { runPipeline, readMetadata } from './ops.js'

let vips = null
let readyPromise = null

function serializeError(err) {
  return {
    name: err?.name || 'Error',
    message: err?.message || String(err),
    code: err?.code || undefined,
    stack: err?.stack || undefined,
  }
}

function init(config) {
  if (!readyPromise) {
    readyPromise = loadVips(config).then((instance) => {
      vips = instance
      return instance
    })
  }
  return readyPromise
}

self.onmessage = async (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  try {
    switch (msg.type) {
      case 'init': {
        await init(msg.config || {})
        self.postMessage({ type: 'ready', id: msg.id })
        break
      }

      case 'run': {
        if (!vips) await init(msg.config || {})
        const input = new Uint8Array(msg.input)
        const out = runPipeline(vips, input, msg.ops, msg.output)
        // 零拷贝回传：out.buffer 已是独立内存，直接把 ArrayBuffer 交出去
        self.postMessage(
          {
            type: 'result',
            id: msg.id,
            buffer: out.buffer.buffer,
            width: out.width,
            height: out.height,
            format: out.format,
            mime: out.mime,
          },
          [out.buffer.buffer],
        )
        break
      }

      case 'metadata': {
        if (!vips) await init(msg.config || {})
        const meta = readMetadata(vips, new Uint8Array(msg.input))
        self.postMessage({ type: 'metadata-result', id: msg.id, meta })
        break
      }

      default:
        break
    }
  } catch (err) {
    const error = serializeError(err)
    if (msg.type === 'init') self.postMessage({ type: 'init-error', id: msg.id, error })
    else if (msg.type === 'metadata') self.postMessage({ type: 'metadata-error', id: msg.id, error })
    else self.postMessage({ type: 'run-error', id: msg.id, error })
  }
}
