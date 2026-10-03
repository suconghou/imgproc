/**
 * image-engine · vips 加载器
 *
 * 负责把 wasm-vips 的胶水代码 + wasm 二进制加载成可用实例。
 * 关键点：浏览器用 vendor/vips-es6.js，Node 用 vendor/vips-node.mjs；
 * 两者的默认行为都是「在自己所在目录找 vips*.wasm」，所以整个文件夹可以原样搬走。
 */

import { EngineError } from './ops.js'

/** 是否运行在 Node（而非浏览器主线程 / Web Worker） */
export function isNodeEnvironment() {
  return (
    typeof process !== 'undefined' &&
    !!process.versions &&
    !!process.versions.node &&
    typeof window === 'undefined' &&
    typeof self === 'undefined'
  )
}

/** 拼接 base 与文件名，兼容 base 带不带结尾斜杠 */
function joinUrl(base, file) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base) || base.startsWith('/')) {
    return base.endsWith('/') ? base + file : base + '/' + file
  }
  return (base.endsWith('/') ? base : base + '/') + file
}

/**
 * libvips 的 WASM 构建带 pthreads，创建线程池时要把 SharedArrayBuffer 交给子 Worker，
 * 而这一步要求页面处于跨源隔离状态。没有隔离时它不会优雅降级，而是直接抛 DataCloneError，
 * 所以我们提前拦下并给出可执行的提示。
 */
function assertCrossOriginIsolated() {
  if (typeof self === 'undefined' || !('crossOriginIsolated' in self)) return
  if (self.crossOriginIsolated) return

  throw new EngineError(
    '当前页面未处于跨源隔离状态（crossOriginIsolated = false），libvips 无法创建线程池。\n' +
    '请在提供本页面的服务器上加上这两个响应头（WASM 资源同源即可，无需额外配置）：\n' +
    '  Cross-Origin-Opener-Policy: same-origin\n' +
    '  Cross-Origin-Embedder-Policy: require-corp\n' +
    'Chromium 137+ 也可以用 Document-Isolation-Policy: isolate-and-credentialless 达到同样效果。',
    'NOT_CROSS_ORIGIN_ISOLATED',
  )
}

/** 默认启用的动态模块（按需下载，不启用就不会被请求） */
const DEFAULT_DYNAMIC_LIBRARIES = ['vips-jxl.wasm', 'vips-heif.wasm']

/**
 * 加载并初始化 wasm-vips。
 *
 * @param {object}  [config]
 * @param {string}  [config.wasmBase]    wasm 所在目录（默认：胶水代码同级目录）
 * @param {boolean} [config.svg]         是否启用 SVG 输入（需 vips-resvg.wasm）
 * @param {Function}[config.locateFile]  自定义定位函数 (file, scriptDirectory) => url（仅直连模式生效）
 * @param {number}  [config.threads]     libvips 内部线程数
 * @param {boolean} [config.workaroundCors] 胶水代码本身是跨源加载时置 true
 * @param {Array}   [config.dynamicLibraries] 完全自定义动态模块列表（高级）
 * @returns {Promise<object>} 已初始化的 vips 模块
 */
export async function loadVips(config = {}) {
  assertCrossOriginIsolated()

  const dynamicLibraries = config.dynamicLibraries
    ? config.dynamicLibraries.slice()
    : DEFAULT_DYNAMIC_LIBRARIES.slice()

  if (config.svg && !dynamicLibraries.includes('vips-resvg.wasm')) {
    dynamicLibraries.push('vips-resvg.wasm')
  }

  const options = { dynamicLibraries }

  // 胶水代码从别的源加载时，它内部派生 pthread 线程池的 Worker 会被同源策略挡下；
  // 打开这个开关，emscripten 会改用 blob 包一层再加载，从而拿到正确的 base URL。
  if (config.workaroundCors === true) options.workaroundCors = true

  const locator = typeof config.locateFile === 'function'
    ? config.locateFile
    : config.wasmBase
      ? (file) => joinUrl(config.wasmBase, file)
      : null
  if (locator) options.locateFile = locator

  const glue = isNodeEnvironment()
    ? await import('./vendor/vips-node.mjs')
    : await import('./vendor/vips-es6.js')

  const Vips = glue.default
  const vips = await Vips(options)

  if (Number.isFinite(config.threads) && config.threads > 0) {
    vips.concurrency(Math.round(config.threads))
  }

  return vips
}
