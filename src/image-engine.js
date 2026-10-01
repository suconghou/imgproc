/**
 * image-engine · 传统 <script> 引入版（不写模块也能用）
 *
 * 用法：
 *   <script src="/image-engine/image-engine.js"></script>
 *   <script>
 *     const engine = await ImageEngine.create()
 *     const out = await engine.process(file, [{ op: 'resize', width: 1200 }], { format: 'webp', quality: 80 })
 *   </script>
 *
 * 也可以显式指定资源目录（当脚本被动态注入、拿不到自身 URL 时）：
 *   <script src="/libs/image-engine/image-engine.js" data-base="/libs/image-engine/"></script>
 */
(function () {
  'use strict'

  if (typeof globalThis === 'undefined') return

  /** 推断本文件所在目录 */
  function detectBase() {
    var el = document.currentScript
    if (!el) {
      var list = document.querySelectorAll('script[src]')
      for (var i = list.length - 1; i >= 0; i--) {
        if (/image-engine(\.min)?\.js(\?.*)?$/.test(list[i].getAttribute('src') || '')) {
          el = list[i]
          break
        }
      }
    }
    if (el) {
      var explicit = el.getAttribute('data-base')
      if (explicit) return explicit.endsWith('/') ? explicit : explicit + '/'
      var src = el.getAttribute('src') || ''
      if (src) return src.replace(/[^/]*$/, '')
    }
    return ''
  }

  var base = detectBase()
  var modulePromise = null

  function loadModule() {
    if (!base) {
      return Promise.reject(new Error(
        '[image-engine] 无法确定资源目录，请给 <script> 加上 data-base 属性，' +
        '或在 create({ workerUrl }) 里显式指定 worker.js 的完整地址。',
      ))
    }
    if (!modulePromise) modulePromise = import(base + 'index.js')
    return modulePromise
  }

  var api = {
    /** 资源目录（以 / 结尾） */
    baseUrl: base,

    /** 环境探测 */
    isSupported: function () {
      return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
    },

    /** 创建引擎，返回 Promise */
    create: function (options) {
      var opts = Object.assign({}, options || {})
      if (base && !opts.workerUrl) opts.workerUrl = base + 'worker.js'
      return loadModule().then(function (mod) {
        return mod.createImageEngine(opts)
      })
    },
  }

  globalThis.ImageEngine = api
  if (typeof module === 'object' && module.exports) module.exports = api
})()
