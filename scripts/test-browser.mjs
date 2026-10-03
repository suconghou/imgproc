#!/usr/bin/env node
/**
 * image-engine 浏览器端验证（无头 Chrome + CDP）
 *
 * 验证两件事：
 *   A. 配好 COOP/COEP（跨源隔离）时，Worker 池 + wasm 资源加载的完整链路可用；
 *   B. 没配响应头时，引擎给出明确的 NOT_CROSS_ORIGIN_ISOLATED 报错，而不是卡死。
 *
 * 实现要点（踩过的坑都在这）：
 *   - 本机沙箱内 Chrome 自己的 sandbox 起不来，必须 --no-sandbox；
 *   - 用浏览器级 endpoint（/json/version）+ Target.createTarget 建立会话，
 *     比连页面级 target 再导航稳定得多；
 *   - 打开 Target.setAutoAttach(flatten) 才能拿到 Worker 内部的异常；
 *   - 结果通过页面 console 回传，不走 Runtime.evaluate（后者在页面忙时会失联）。
 *
 * 用法：pnpm test:browser
 *   CHROME_PATH          覆盖浏览器路径
 *   SMOKE_TIMEOUT_MS     单次用例超时，默认 90000
 *   SMOKE_WORKERS        强制 Worker 池大小（诊断用）
 */

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makePng } from './lib/make-png.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_DIR = path.join(ROOT, 'dist', 'image-engine')
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000)
/** 仅用于诊断：强制 Worker 池大小 */
const WORKERS = process.env.SMOKE_WORKERS

if (!existsSync(path.join(ENGINE_DIR, 'index.js'))) {
  console.error('✗ 找不到 dist/image-engine，请先执行：pnpm build')
  process.exit(1)
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到浏览器：${CHROME}\n  可用 CHROME_PATH 环境变量指定。`)
  process.exit(1)
}

/* ─────────────── 被测页面 ─────────────── */

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>engine browser smoke</title></head>
<body><div id="out">running</div>
<script type="module">
const qs = new URLSearchParams(location.search)
const iso = qs.has('iso')
const workers = qs.get('workers')
const checks = []
const push = (name, ok, extra) => checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) })
const mark = (s) => console.log('PROGRESS:' + s)
const done = (err) => {
  const payload = err
    ? { ok: false, error: (err && err.stack) || String(err), checks }
    : { ok: checks.every((c) => c.ok), checks }
  console.log('ENGINE_RESULT:' + JSON.stringify(payload))
}
addEventListener('error', (e) => done(e.error || e.message))
addEventListener('unhandledrejection', (e) => done(e.reason))

try {
  mark('boot')
  push('页面跨源隔离状态符合预期', globalThis.crossOriginIsolated === iso, 'crossOriginIsolated=' + globalThis.crossOriginIsolated)

  mark('importing')
  const mod = await import('/engine/index.js')
  push('ESM 入口可加载', true)
  push('EngineError 可导出', typeof mod.EngineError === 'function')

  mark('creating-engine')
  let engine = null
  try {
    engine = await mod.createImageEngine(workers ? { workers: Number(workers) } : undefined)
  } catch (err) {
    if (iso) throw err
    push('未隔离时创建引擎失败', true)
    push('错误 code 为 NOT_CROSS_ORIGIN_ISOLATED', err.code === 'NOT_CROSS_ORIGIN_ISOLATED', err.code)
    push('报错里给出了 COOP 响应头提示', /Cross-Origin-Opener-Policy/.test(err.message))
    mark('expected-failure')
    done()
    document.getElementById('out').textContent = 'finished'
    throw { __handled: true }
  }

  mark('engine-created')
  push('引擎模式为 worker 池', engine.mode === 'worker', engine.mode)
  push('Worker 池大小 >= 1', engine.size >= 1, engine.size)

  mark('fetch-source')
  const file = new File([await (await fetch('/test.png')).blob()], 'test.png', { type: 'image/png' })

  mark('metadata')
  const meta = await engine.metadata(file)
  push('元信息 800x600', meta.width === 800 && meta.height === 600, meta.width + 'x' + meta.height)

  mark('resize')
  const resized = await engine.resize(file, { width: 200 })
  push('缩放 inside 200x150', resized.width === 200 && resized.height === 150, resized.width + 'x' + resized.height)

  mark('webp')
  const webp = await engine.convert(file, { format: 'webp', quality: 78 })
  push('转 webp 成功', webp.format === 'webp' && webp.size > 0, webp.size + ' bytes / ' + webp.mime)
  push('返回 Blob 类型正确', webp.blob instanceof Blob && webp.blob.type === 'image/webp', webp.blob && webp.blob.type)

  mark('avif')
  const avif = await engine.convert(file, { format: 'avif', quality: 50 })
  const avifBack = await engine.metadata(avif.buffer)
  push('AVIF 编码 + 回读', avif.format === 'avif' && avifBack.width === 800, avif.size + ' bytes')

  mark('combo')
  const combo = await engine.process(file, [
    { op: 'resize', width: 400, height: 400, fit: 'cover' },
    { op: 'rotate', angle: 90 },
    { op: 'crop', left: 0, top: 0, width: 200, height: 100 },
  ], { format: 'jpeg', quality: 80 })
  push('组合管线 200x100 jpeg', combo.width === 200 && combo.height === 100 && combo.format === 'jpeg', combo.width + 'x' + combo.height)

  mark('bounds')
  let code = ''
  try { await engine.crop(file, { left: 700, top: 0, width: 300, height: 100 }) }
  catch (err) { code = err.code }
  push('越界裁剪抛 OUT_OF_BOUNDS', code === 'OUT_OF_BOUNDS', code)

  // 造一张大且带噪点的 PNG：用来产生足够长的编码时间，才能观察到进度与中断
  mark('make-big')
  async function makeBigFile(w, h) {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    const d = ctx.createImageData(w, h)
    for (let i = 0; i < d.data.length; i += 4) {
      const p = i >> 2
      d.data[i] = (p * 7 + (p >> 9) * 13) & 255
      d.data[i + 1] = (p * 3 + (p >> 7) * 29) & 255
      d.data[i + 2] = (p * 11 + (p >> 11) * 5) & 255
      d.data[i + 3] = 255
    }
    ctx.putImageData(d, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return new File([blob], 'big.png', { type: 'image/png' })
  }
  const bigFile = await makeBigFile(1600, 1600)
  const hugeFile = await makeBigFile(2600, 2600)

  mark('progress')
  const pcts = []
  const bigOut = await engine.process(bigFile, [{ op: 'resize', width: 1200 }], {
    format: 'avif', quality: 60, effort: 5,
    onProgress: (p) => pcts.push(p),
  })
  push('进度回调跨 Worker 可用', pcts.length > 0, '收到 ' + pcts.length + ' 次')
  push('进度值在 0-100 且以 100 收尾',
    pcts.every((p) => p >= 0 && p <= 100) && pcts[pcts.length - 1] === 100,
    JSON.stringify(pcts.slice(-5)))
  push('大图处理成功', bigOut.size > 0 && bigOut.format === 'avif', bigOut.size + ' B')

  mark('cancel')
  const ac = new AbortController()
  const started = performance.now()
  const task = engine.process(hugeFile, [], { format: 'avif', quality: 80, effort: 9 }, { signal: ac.signal })
  setTimeout(() => ac.abort(), 300)
  let cancelCode = ''
  try { await task } catch (err) { cancelCode = err.code }
  const elapsed = Math.round(performance.now() - started)
  push('abort 能中断进行中的任务', cancelCode === 'ABORTED', cancelCode + ' / ' + elapsed + 'ms')

  // 取消会终止并回收该 Worker，这里验证引擎随后仍可正常工作
  const after = await engine.convert(file, { format: 'webp', quality: 70 })
  push('取消后引擎仍可用（Worker 已补位）',
    after.size > 0 && after.format === 'webp', after.size + ' B')

  mark('destroy')
  engine.destroy()
  push('destroy 后再次处理被拒', await (async () => {
    try { await engine.convert(file, { format: 'png' }); return false }
    catch (err) { return err.code === 'DESTROYED' || err.code === 'WORKER_ERROR' }
  })())

  mark('done')
  done()
} catch (err) {
  if (!err || !err.__handled) done(err)
}
document.getElementById('out').textContent = 'finished'
<\/script></body></html>`

/* ─────────────── 静态服务器 ─────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const TEST_PNG = makePng(800, 600)
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// CDN 侧对工具包资源要放行的头，与 site-src/_headers 保持一致
const CDN_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

/**
 * 用例 C：消费方页面在源 A，工具包从源 B 跨源 <script src> 引入。
 * 这是「部署到 CDN 给别的站点直接引用」的关键验证。
 */
const CROSS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>engine cross-origin smoke</title></head>
<body><div id="out">running</div>
<script src="__CDN__/image-engine/image-engine.js"><\/script>
<script>
const checks = []
const push = (name, ok, extra) => checks.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) })
const done = (err) => console.log('ENGINE_RESULT:' + JSON.stringify(
  err ? { ok: false, error: (err && err.stack) || String(err), checks } : { ok: checks.every((c) => c.ok), checks }))
addEventListener('error', (e) => done(e.error || e.message))
addEventListener('unhandledrejection', (e) => done(e.reason))

// 注意：这里是经典 <script>，顶层 await 不合法，必须包一层 async IIFE
;(async () => {
try {
  push('消费方页面已跨源隔离', globalThis.crossOriginIsolated === true, globalThis.crossOriginIsolated)

  const engine = await ImageEngine.create()
  push('跨源引用：引擎创建成功', true, engine.mode)
  push('走的是 worker 池（跨源 Worker 已被包装）', engine.mode === 'worker', engine.mode)

  const file = new File([await (await fetch('/test.png')).blob()], 'test.png', { type: 'image/png' })
  const meta = await engine.metadata(file)
  push('能读元信息', meta.width === 800 && meta.height === 600, meta.width + 'x' + meta.height)

  const webp = await engine.convert(file, { format: 'webp', quality: 80 })
  push('跨源引用下能正常转码', webp.size > 0 && webp.format === 'webp', webp.size + ' B / ' + webp.mime)

  const avif = await engine.process(file, [{ op: 'resize', width: 200 }], { format: 'avif', quality: 50 })
  push('跨源下 AVIF 动态模块可用', avif.size > 0 && avif.width === 200, avif.size + ' B')

  engine.destroy()
  done()
} catch (err) { done(err) }
})()
document.getElementById('out').textContent = 'finished'
<\/script></body></html>`

/** 模拟 CDN：把编译产物挂在 /image-engine/ 下，并带上放行头 */
function createCdnServer(engineDir) {
  const MOUNT = '/image-engine/'
  return http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (!pathname.startsWith(MOUNT)) {
      res.writeHead(404, CDN_HEADERS)
      res.end('not found')
      return
    }
    const full = path.join(engineDir, pathname.slice(MOUNT.length))
    if (!full.startsWith(engineDir)) { res.writeHead(403, CDN_HEADERS); res.end(); return }
    readFile(full)
      .then((data) => {
        res.writeHead(200, {
          ...CDN_HEADERS,
          'content-type': MIME[path.extname(full)] || 'application/octet-stream',
          'content-length': data.length,
        })
        res.end(data)
      })
      .catch(() => { res.writeHead(404, CDN_HEADERS); res.end('not found: ' + pathname) })
  })
}

function createServer(withIsolation, pageHtml = PAGE) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)
    const base = withIsolation ? ISOLATION_HEADERS : {}

    if (pathname === '/favicon.ico') { res.writeHead(204, base); res.end(); return }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { ...base, 'content-type': MIME['.html'] })
      res.end(pageHtml)
      return
    }
    if (pathname === '/test.png') {
      res.writeHead(200, { ...base, 'content-type': 'image/png' })
      res.end(TEST_PNG)
      return
    }
    if (pathname.startsWith('/engine/')) {
      const full = path.join(ENGINE_DIR, pathname.slice('/engine/'.length))
      if (!full.startsWith(ENGINE_DIR)) { res.writeHead(403, base); res.end(); return }
      readFile(full)
        .then((data) => {
          res.writeHead(200, {
            ...base,
            'content-type': MIME[path.extname(full)] || 'application/octet-stream',
            'content-length': data.length,
          })
          res.end(data)
        })
        .catch(() => { res.writeHead(404, base); res.end('not found: ' + pathname) })
      return
    }
    res.writeHead(404, base)
    res.end('not found')
  })
}

/* ─────────────── 工具 ─────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

/** 等待浏览器级调试 endpoint 就绪 */
async function findBrowserWs(port) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch { /* 端口还没起来 */ }
    await sleep(250)
  }
  throw new Error('无法连接到无头 Chrome 的调试端口')
}

/* ─────────────── 单个用例 ─────────────── */

async function runCase({ iso, crossOrigin = false }) {
  // 用例 C：页面与工具包不同源（模拟从 CDN 引用）
  const cdnServer = crossOrigin ? createCdnServer(ENGINE_DIR) : null
  const cdnPort = cdnServer ? await listen(cdnServer) : 0
  const pageHtml = crossOrigin ? CROSS_PAGE.replace('__CDN__', `http://127.0.0.1:${cdnPort}`) : PAGE

  const server = createServer(iso, pageHtml)
  const httpPort = await listen(server)
  const cdpPort = await freePort()
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'engine-smoke-'))

  let chrome
  const logs = []
  let chromeErr = ''

  try {
    chrome = spawn(CHROME, [
      '--headless=new',
      '--no-sandbox', // 本机沙箱内 Chrome 自己的 sandbox 无法初始化
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    chrome.stderr.on('data', (d) => { chromeErr += d.toString() })
    chrome.on('exit', (c) => { if (c) chromeErr += `\nchrome exited with ${c}` })

    const ws = new WebSocket(await findBrowserWs(cdpPort))
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败：' + chromeErr.slice(-400))), { once: true })
    })

    // 单一消息分发：用 pending Map 匹配响应，避免每次 call 都挂监听器（会触发 MaxListeners 告警）
    const pendingCalls = new Map()
    let msgId = 0
    const attached = new Map() // targetId -> sessionId

    const call = (method, params, sessionId, ms = 15000) => new Promise((resolve) => {
      const id = ++msgId
      const timer = setTimeout(() => {
        pendingCalls.delete(id)
        resolve({ timedOut: true })
      }, ms)
      pendingCalls.set(id, { resolve, timer })
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)

      // CDP 响应（只有 id，没有 method）
      if (msg.id !== undefined && pendingCalls.has(msg.id)) {
        const { resolve, timer } = pendingCalls.get(msg.id)
        pendingCalls.delete(msg.id)
        clearTimeout(timer)
        resolve(msg)
        return
      }

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params
        attached.set(targetInfo.targetId, sessionId)
        logs.push(`[attached] ${targetInfo.type} ${targetInfo.url}`)
        // 子 target（Worker）也要开 Runtime，否则看不到它内部的异常
        call('Runtime.enable', {}, sessionId, 5000)
        call('Log.enable', {}, sessionId, 5000)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
        logs.push(`[${msg.sessionId ? 'worker:' : ''}${msg.params.type}] ${text}`)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        logs.push(`[${msg.sessionId ? 'worker:' : ''}exception] ${d?.text} ${d?.exception?.description || ''}`)
      }
      if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry
        if (e.level === 'error' || e.level === 'warning') {
          logs.push(`[${msg.sessionId ? 'worker:' : ''}${e.level}] ${e.text}`)
        }
      }
    })

    // 浏览器级自动挂载，覆盖页面 + Worker
    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

    const created = await call('Target.createTarget', { url: 'about:blank' })
    const targetId = created.result?.targetId
    if (!targetId) throw new Error('创建页面 target 失败：' + JSON.stringify(created).slice(0, 300))

    const deadlineAttach = Date.now() + 10000
    while (!attached.has(targetId) && Date.now() < deadlineAttach) await sleep(100)
    const pageSession = attached.get(targetId)
    if (!pageSession) throw new Error('页面 target 未被挂载')

    await call('Runtime.enable', {}, pageSession)
    await call('Log.enable', {}, pageSession)
    await call('Page.enable', {}, pageSession)

    const pageUrl = `http://127.0.0.1:${httpPort}/?${iso ? 'iso=1' : 'plain=1'}${WORKERS ? '&workers=' + WORKERS : ''}`
    await call('Page.navigate', { url: pageUrl }, pageSession)

    const RESULT_PREFIX = 'ENGINE_RESULT:'
    const deadline = Date.now() + TIMEOUT_MS
    let result = null
    while (Date.now() < deadline && !result) {
      const line = logs.find((l) => l.includes(RESULT_PREFIX))
      if (line) {
        try { result = JSON.parse(line.slice(line.indexOf(RESULT_PREFIX) + RESULT_PREFIX.length)) }
        catch { /* 数据还没收全 */ }
      }
      if (!result) await sleep(200)
    }

    const progress = logs.filter((l) => l.includes('PROGRESS:')).pop()
    const lastProgress = progress ? progress.slice(progress.indexOf('PROGRESS:') + 'PROGRESS:'.length) : '(未开始)'

    ws.close()
    if (!result) return { timedOut: true, lastProgress, logs, chromeErr, checks: [] }
    return { ...result, logs, chromeErr }
  } finally {
    try { chrome?.kill('SIGKILL') } catch { /* 忽略 */ }
    await new Promise((r) => server.close(r))
    if (cdnServer) await new Promise((r) => cdnServer.close(r))
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

/* ─────────────── 报告 ─────────────── */

const showLogs = (logs) => logs
  .filter((l) => /PROGRESS:|attached|exception|\[error|\[warning/.test(l))
  .map((l) => '    ' + l)
  .join('\n')

function report(title, res) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
  if (res.timedOut) {
    console.log(`  \x1b[31m✗ 超时\x1b[0m（最后进度：${res.lastProgress}）`)
    console.log('  控制台：\n' + (showLogs(res.logs) || '    (无输出)'))
    return 1
  }
  let failed = 0
  for (const c of res.checks) {
    if (c.ok) {
      console.log(`  \x1b[32m✓\x1b[0m ${c.name}${c.extra && !/crossOriginIsolated/.test(c.name) ? '  (' + c.extra + ')' : ''}`)
    } else {
      failed++
      console.log(`  \x1b[31m✗\x1b[0m ${c.name}${c.extra ? '  → ' + c.extra : ''}`)
    }
  }
  if (res.error) {
    failed++
    console.log(`  \x1b[31m✗ 页面抛出异常\x1b[0m\n${res.error.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n')}`)
  }
  return failed
}

console.log('\nimage-engine 浏览器验证（无头 Chrome）')

let failures = 0
failures += report('用例 A：已配置 COOP/COEP（预期全链路可用）', await runCase({ iso: true }))
failures += report('用例 B：未配置响应头（预期给出明确报错）', await runCase({ iso: false }))
failures += report('用例 C：工具包跨源引用（页面在源 A、工具包在源 B）', await runCase({ iso: true, crossOrigin: true }))

console.log(`\n${'─'.repeat(52)}`)
if (failures) {
  console.error(`\x1b[31m浏览器验证失败：${failures} 项\x1b[0m`)
  process.exitCode = 1
} else {
  console.log('\x1b[32m浏览器验证全部通过\x1b[0m')
}
