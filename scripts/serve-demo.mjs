#!/usr/bin/env node
/**
 * 本地预览「将要部署到 Cloudflare 的那个目录」。
 *
 * 它只服务 site/，并按 site/_headers 里的规则挂响应头 ——
 * 所以本地看到的行为和线上一致（跨源隔离、跨源引用放行、wasm 的 MIME 与缓存）。
 *
 * 用法：pnpm demo [端口]      默认 8787
 *   site/ 不存在时会自动先跑一次 `pnpm build`
 */

import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE_DIR = path.join(ROOT, 'site')
const PORT = Number(process.argv[2] || 8787)

if (!existsSync(path.join(SITE_DIR, 'index.html'))) {
  console.log('■ site/ 不存在，先组装一次')
  execFileSync('node', [path.join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' })
  execFileSync('node', [path.join(ROOT, 'scripts', 'build-site.mjs')], { stdio: 'inherit' })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 解析 Cloudflare 的 _headers 文件（与线上同样的语义）：
 * 以非空白开头的行是 URL 规则，其后缩进的行是 `名字: 值`。
 */
function parseHeaders(text) {
  const rules = []
  let current = null
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} }
      rules.push(current)
      continue
    }
    if (!current) continue
    const i = raw.indexOf(':')
    if (i < 0) continue
    const name = raw.slice(0, i).trim()
    const value = raw.slice(i + 1).trim()
    // 与 Cloudflare 一致：同名头重复出现时用逗号合并
    current.headers[name] = current.headers[name] ? current.headers[name] + ', ' + value : value
  }
  return rules
}

const matchPattern = (pattern, pathname) =>
  pattern.endsWith('*') ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern

const HEADER_RULES = parseHeaders(await readFile(path.join(SITE_DIR, '_headers'), 'utf8'))

function headersFor(pathname) {
  const out = {}
  for (const rule of HEADER_RULES) {
    if (matchPattern(rule.pattern, pathname)) Object.assign(out, rule.headers)
  }
  return out
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const extra = headersFor(pathname)

  if (pathname === '/favicon.ico') { res.writeHead(204, extra); res.end(); return }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = path.join(SITE_DIR, rel)
  if (!full.startsWith(SITE_DIR)) { res.writeHead(403, extra); res.end('forbidden'); return }

  readFile(full)
    .then((data) => {
      res.writeHead(200, {
        ...extra,
        'content-type': MIME[path.extname(full)] || 'application/octet-stream',
        'content-length': data.length,
      })
      res.end(data)
    })
    .catch(() => {
      res.writeHead(404, { ...extra, 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found: ' + pathname)
    })
})

server.listen(PORT, '127.0.0.1', () => {
  const iso = headersFor('/')
  console.log(`\n本地预览（服务 site/，按 _headers 加头）：\x1b[36mhttp://127.0.0.1:${PORT}/\x1b[0m`)
  console.log(`  页面响应头：${Object.keys(iso).join(', ') || '(无)'}`)
  console.log('  Ctrl+C 退出\n')
})
