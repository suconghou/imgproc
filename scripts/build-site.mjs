#!/usr/bin/env node
/**
 * 组装可部署到 Cloudflare 的静态目录。
 *
 *   site/
 *   ├── index.html            站点页（同时是跨源隔离配置的参考实现）
 *   ├── _headers              Cloudflare 响应头规则（跨源隔离 + 跨源引用放行）
 *   └── image-engine/         编译好的工具包本体（来自 dist/image-engine）
 *
 * 用法：
 *   node scripts/build-site.mjs                  → 输出到 site/
 *   node scripts/build-site.mjs --out dist/site  → 自定义输出目录
 *
 * 前置：先跑 `pnpm build` 产出 dist/image-engine。
 * 部署：wrangler.jsonc 里 assets.directory 指向本目录。
 */

import { existsSync } from 'node:fs'
import { mkdir, rm, cp, readdir, stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE_SRC = path.join(ROOT, 'site-src')
const ENGINE_OUT = path.join(ROOT, 'dist', 'image-engine')

const argv = process.argv.slice(2)
const outFlag = argv.indexOf('--out')
const OUT_DIR = path.resolve(ROOT, outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : 'site')

async function walk(dir, base = dir, out = []) {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) await walk(full, base, out)
    else out.push({ rel: path.relative(base, full), size: info.size })
  }
  return out
}

const human = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`)

async function main() {
  if (!existsSync(path.join(ENGINE_OUT, 'index.js'))) {
    console.error('✗ 找不到 dist/image-engine，请先执行：pnpm build')
    process.exit(1)
  }
  if (!existsSync(path.join(SITE_SRC, 'index.html'))) {
    console.error(`✗ 找不到站点源文件：${SITE_SRC}/index.html`)
    process.exit(1)
  }
  if (OUT_DIR === ROOT || ROOT.startsWith(OUT_DIR + path.sep)) {
    throw new Error(`输出目录不能是仓库根目录或其父级：${OUT_DIR}`)
  }

  console.log('■ 清理输出目录')
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  console.log('■ 拷贝站点源文件（index.html / _headers）')
  await cp(SITE_SRC, OUT_DIR, { recursive: true })

  console.log('■ 拷贝工具包 dist/image-engine → image-engine/')
  await cp(ENGINE_OUT, path.join(OUT_DIR, 'image-engine'), { recursive: true })

  const files = await walk(OUT_DIR)
  const total = files.reduce((n, f) => n + f.size, 0)
  console.log(`\n✅ 可部署目录就绪 → ${path.relative(ROOT, OUT_DIR)}/\n`)
  for (const f of files.filter((f) => !f.rel.startsWith('image-engine' + path.sep))) {
    console.log(`   ${f.rel.padEnd(28)} ${human(f.size).padStart(9)}`)
  }
  const engineFiles = files.filter((f) => f.rel.startsWith('image-engine' + path.sep))
  console.log(`   ${'image-engine/'.padEnd(28)} ${human(engineFiles.reduce((n, f) => n + f.size, 0)).padStart(9)}  (${engineFiles.length} 个文件)`)
  console.log(`\n   合计 ${human(total)}，共 ${files.length} 个文件`)
  console.log('   部署：npx wrangler deploy（wrangler.jsonc 的 assets.directory 指向本目录）')

  const headers = await readFile(path.join(OUT_DIR, '_headers'), 'utf8')
  const ruleCount = headers.split('\n').filter((l) => l && !/^\s/.test(l) && !l.startsWith('#')).length
  console.log(`   _headers 规则数：${ruleCount}`)
}

main().catch((err) => {
  console.error('\n✗ 组装失败：', err.message)
  process.exit(1)
})
