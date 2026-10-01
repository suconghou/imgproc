#!/usr/bin/env node
/**
 * 本地试用 image-engine 的最小服务器。
 *
 * 起一个带 COOP/COEP 响应头的静态服务，把 dist/image-engine 挂到 /engine/，
 * 再提供一个可直接操作的演示页面。用于拿到工具包后立刻验证效果。
 *
 * 用法：npm run demo（或 node scripts/serve-demo.mjs [端口]）
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_DIR = path.join(ROOT, 'dist', 'image-engine')
const PORT = Number(process.argv[2] || 8787)

if (!existsSync(path.join(ENGINE_DIR, 'index.js'))) {
  console.error('✗ 找不到 dist/image-engine，请先执行：npm run build')
  process.exit(1)
}

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

/** 跨源隔离头：libvips 的 pthread 构建必须要 */
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const DEMO = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>image-engine 演示</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: #0e1116; color: #e8edf5;
    font: 14px/1.6 ui-sans-serif, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: #93a1b5; margin: 0 0 24px; }
  .panel {
    background: #161b23; border: 1px solid #262e3a; border-radius: 12px;
    padding: 20px; margin-bottom: 20px;
  }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
  label { display: block; font-size: 12px; color: #93a1b5; margin-bottom: 6px; letter-spacing: .3px; }
  select, input[type=number] {
    width: 100%; padding: 9px 10px; background: #0e1116; color: #e8edf5;
    border: 1px solid #2f3a49; border-radius: 8px; font: inherit;
  }
  input[type=range] { width: 100%; accent-color: #f97316; }
  input[type=file] { color: #93a1b5; }
  .row { display: flex; align-items: center; gap: 12px; }
  .val { color: #f97316; font-variant-numeric: tabular-nums; font-weight: 600; min-width: 34px; }
  button {
    padding: 10px 20px; border: 0; border-radius: 8px; cursor: pointer;
    background: #f97316; color: #1a1005; font: 600 14px/1 inherit;
  }
  button:disabled { background: #2f3a49; color: #6b7787; cursor: not-allowed; }
  #drop {
    border: 1px dashed #3a4557; border-radius: 12px; padding: 28px; text-align: center;
    color: #93a1b5; transition: .15s;
  }
  #drop.over { border-color: #f97316; background: #1d1710; }
  .list { display: grid; gap: 12px; margin-top: 20px; }
  .item {
    display: grid; grid-template-columns: 88px 1fr auto; gap: 16px; align-items: center;
    background: #161b23; border: 1px solid #262e3a; border-radius: 12px; padding: 14px;
  }
  .thumb { width: 88px; height: 66px; object-fit: contain; background: #0e1116; border-radius: 8px; }
  .name { font-weight: 600; word-break: break-all; }
  .meta { color: #93a1b5; font-size: 12px; font-variant-numeric: tabular-nums; }
  .save { color: #22c55e; font-weight: 600; }
  .grow { color: #ef4444; font-weight: 600; }
  a.dl { color: #60a5fa; text-decoration: none; font-weight: 600; }
  .err { color: #ef4444; }
  .note { color: #93a1b5; font-size: 12px; margin-top: 10px; }
  code { background: #0e1116; padding: 2px 6px; border-radius: 5px; color: #e8edf5; }
</style>
</head><body><div class="wrap">
  <h1>image-engine 演示</h1>
  <p class="sub">全部处理都在你的浏览器里完成，图片不会上传到任何服务器。</p>

  <div class="panel">
    <div class="grid">
      <div>
        <label>输出格式</label>
        <select id="format">
          <option value="">保持原格式</option>
          <option value="webp">WebP</option>
          <option value="avif">AVIF</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG（无损）</option>
          <option value="jxl">JPEG XL</option>
        </select>
      </div>
      <div>
        <label>质量（有损格式生效）</label>
        <div class="row"><input type="range" id="quality" min="1" max="100" value="80"><span class="val" id="qv">80</span></div>
      </div>
      <div>
        <label>最大宽度 px（留空则不缩放）</label>
        <input type="number" id="maxWidth" placeholder="例如 1600" min="1">
      </div>
    </div>
    <div class="note" id="status">引擎加载中…</div>
  </div>

  <div class="panel">
    <div id="drop">把图片拖进来，或 <input type="file" id="files" multiple accept="image/*"> <br><span class="note">支持 JPEG / PNG / WebP / GIF / AVIF / TIFF / JXL</span></div>
    <div class="list" id="list"></div>
  </div>
</div>

<script src="/engine/image-engine.js"></script>
<script>
const listEl = document.getElementById('list')
const statusEl = document.getElementById('status')
const qualityEl = document.getElementById('quality')
const qvEl = document.getElementById('qv')
let engine = null

qualityEl.addEventListener('input', () => { qvEl.textContent = qualityEl.value })

ImageEngine.create()
  .then((e) => { engine = e; statusEl.textContent = '引擎就绪（' + e.mode + ' 模式，' + e.size + ' 个 Worker）' })
  .catch((err) => { statusEl.innerHTML = '<span class="err">引擎启动失败：' + err.message.replace(/\\n/g, '<br>') + '</span>' })

document.getElementById('files').addEventListener('change', (e) => run([...e.target.files]))
const drop = document.getElementById('drop')
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); run([...e.dataTransfer.files]) })

const fmt = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'

async function run(files) {
  if (!engine) return
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (!images.length) return

  for (const file of images) {
    const row = document.createElement('div')
    row.className = 'item'
    row.innerHTML = '<img class="thumb"><div><div class="name"></div><div class="meta">处理中…</div></div><div class="act"></div>'
    row.querySelector('.name').textContent = file.name
    const before = URL.createObjectURL(file)
    row.querySelector('.thumb').src = before
    listEl.prepend(row)

    try {
      const ops = []
      const w = Number(document.getElementById('maxWidth').value)
      if (w > 0) ops.push({ op: 'resize', width: w, fit: 'inside' })

      const output = {}
      const format = document.getElementById('format').value
      if (format) output.format = format
      output.quality = Number(qualityEl.value)

      const t0 = performance.now()
      const out = await engine.process(file, ops, output)
      const ms = Math.round(performance.now() - t0)

      const url = URL.createObjectURL(out.blob)
      row.querySelector('.thumb').src = url
      const delta = out.size - file.size
      const pct = ((delta / file.size) * 100).toFixed(1)
      row.querySelector('.meta').innerHTML =
        file.name.split('.').pop().toUpperCase() + ' → ' + out.format.toUpperCase() + ' · ' +
        out.width + '×' + out.height + '<br>' +
        fmt(file.size) + ' → ' + fmt(out.size) + ' · ' +
        (delta < 0 ? '<span class="save">省 ' + Math.abs(pct) + '%</span>' : '<span class="grow">增 ' + pct + '%</span>') +
        ' · ' + ms + 'ms'
      row.querySelector('.act').innerHTML =
        '<a class="dl" download="' + file.name.replace(/\\.[^.]+$/, '') + '.' + out.format + '" href="' + url + '">下载</a>'
    } catch (err) {
      row.querySelector('.meta').innerHTML = '<span class="err">' + err.message + '</span>'
    }
  }
}
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/favicon.ico') { res.writeHead(204, ISOLATION); res.end(); return }
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { ...ISOLATION, 'content-type': MIME['.html'] })
    res.end(DEMO)
    return
  }
  if (pathname.startsWith('/engine/')) {
    const full = path.join(ENGINE_DIR, pathname.slice('/engine/'.length))
    if (!full.startsWith(ENGINE_DIR)) { res.writeHead(403, ISOLATION); res.end(); return }
    readFile(full)
      .then((data) => {
        res.writeHead(200, {
          ...ISOLATION,
          'content-type': MIME[path.extname(full)] || 'application/octet-stream',
          'content-length': data.length,
        })
        res.end(data)
      })
      .catch(() => { res.writeHead(404, ISOLATION); res.end('not found') })
    return
  }
  res.writeHead(404, ISOLATION)
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nimage-engine 演示已启动：\x1b[36mhttp://127.0.0.1:${PORT}/\x1b[0m`)
  console.log('（已带上 COOP/COEP 响应头，Ctrl+C 退出）\n')
})
