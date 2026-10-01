#!/usr/bin/env node
/**
 * 构建 image-engine 独立工具包。
 *
 * 产物是一个完全自包含的文件夹，可以原样拷进任何项目：
 *   dist/image-engine/
 *     index.js            对外入口（ESM）
 *     image-engine.js     传统 <script> 引入版
 *     worker.js           Web Worker
 *     loader.js / ops.js  内部实现
 *     index.d.ts          TypeScript 类型
 *     package.json        使 node 也按 ESM 解析本目录
 *     README.md           接口文档（来自仓库根 README.md）
 *     vendor/             wasm-vips 的胶水代码与 wasm 二进制
 *
 * 用法：
 *   node scripts/build.mjs                              → 输出到 dist/image-engine
 *   node scripts/build.mjs --copy-to ../site/public/engine  → 额外整包同步到指定目录
 *   node scripts/build.mjs --out dist/foo                → 自定义输出目录
 *
 * wasm-vips 的版本可用环境变量覆盖：WASM_VIPS_VERSION=0.0.19
 */

import { existsSync } from 'node:fs'
import { mkdir, rm, cp, readdir, stat, writeFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'src')
const CACHE_DIR = path.join(ROOT, '.cache')

/** 原始命令行参数 */
const argv = process.argv.slice(2)

/** 读取 --flag value 形式的参数 */
function argValue(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

const OUT_DIR = path.resolve(ROOT, argValue('--out') || path.join('dist', 'image-engine'))
const COPY_TO = argValue('--copy-to') ? path.resolve(ROOT, argValue('--copy-to')) : null

const WASM_VIPS_VERSION = process.env.WASM_VIPS_VERSION || '0.0.19'
const TOOLKIT_VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'

/** 从 npm 取 wasm-vips 并解包，返回包根目录 */
async function ensureVendor() {
  const pkgDir = path.join(CACHE_DIR, `wasm-vips-${WASM_VIPS_VERSION}`, 'package')
  if (existsSync(path.join(pkgDir, 'lib', 'vips.wasm'))) return pkgDir

  const tarball = path.join(CACHE_DIR, `wasm-vips-${WASM_VIPS_VERSION}.tgz`)
  if (!existsSync(tarball)) {
    const url = `https://registry.npmjs.org/wasm-vips/-/wasm-vips-${WASM_VIPS_VERSION}.tgz`
    console.log(`↓ 下载 wasm-vips@${WASM_VIPS_VERSION} …`)
    await mkdir(CACHE_DIR, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载失败：${res.status} ${res.statusText} ${url}`)
    await writeFile(tarball, Buffer.from(await res.arrayBuffer()))
  }

  const dest = path.join(CACHE_DIR, `wasm-vips-${WASM_VIPS_VERSION}`)
  await mkdir(dest, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', dest], { stdio: 'inherit' })
  return pkgDir
}

/** 递归列出文件 */
async function walk(dir, base = dir, out = []) {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) await walk(full, base, out)
    else out.push({ rel: path.relative(base, full), full, size: info.size })
  }
  return out
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function main() {
  if (OUT_DIR === ROOT || ROOT.startsWith(OUT_DIR + path.sep)) {
    throw new Error(`输出目录不能是仓库根目录或其父级：${OUT_DIR}`)
  }
  const vendor = await ensureVendor()

  console.log('■ 清理输出目录')
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(path.join(OUT_DIR, 'vendor'), { recursive: true })

  console.log('■ 拷贝工具包源码')
  await cp(SRC_DIR, OUT_DIR, { recursive: true })

  // 接口文档以仓库根 README.md 为唯一来源，一起放进产物
  await cp(path.join(ROOT, 'README.md'), path.join(OUT_DIR, 'README.md'))

  console.log('■ 拷贝 wasm-vips 运行时')
  const vendorFiles = [
    'vips-es6.js',        // 浏览器 ESM 胶水
    'vips-node.mjs',      // Node ESM 胶水
    'vips.wasm',          // 核心（JPEG/PNG/WebP/GIF/TIFF）
    'vips-heif.wasm',     // 动态模块：AVIF
    'vips-jxl.wasm',      // 动态模块：JPEG XL
    'vips-resvg.wasm',    // 动态模块：SVG
  ]
  for (const f of vendorFiles) {
    await cp(path.join(vendor, 'lib', f), path.join(OUT_DIR, 'vendor', f))
  }
  for (const f of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    if (existsSync(path.join(vendor, f))) await cp(path.join(vendor, f), path.join(OUT_DIR, f))
  }

  console.log('■ 生成 package.json / manifest.json')
  const pkg = {
    name: 'image-engine',
    version: TOOLKIT_VERSION,
    description: '浏览器端高性能图片处理引擎（wasm-vips / libvips）',
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
    exports: {
      '.': { types: './index.d.ts', default: './index.js' },
      './worker.js': './worker.js',
      './image-engine.js': './image-engine.js',
    },
    sideEffects: false,
    browser: './index.js',
  }
  await writeFile(path.join(OUT_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  const files = await walk(OUT_DIR)
  const manifest = {
    name: 'image-engine',
    version: TOOLKIT_VERSION,
    runtime: `wasm-vips@${WASM_VIPS_VERSION}`,
    builtAt: new Date().toISOString(),
    entry: 'index.js',
    globalEntry: 'image-engine.js',
    totalSize: files.reduce((n, f) => n + f.size, 0),
    files: files.map((f) => f.rel),
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  if (COPY_TO) {
    console.log(`■ 整包同步 → ${path.relative(ROOT, COPY_TO) || COPY_TO}`)
    await rm(COPY_TO, { recursive: true, force: true })
    await mkdir(path.dirname(COPY_TO), { recursive: true })
    await cp(OUT_DIR, COPY_TO, { recursive: true })
  }

  // ── 汇总 ──
  const all = await walk(OUT_DIR)
  const total = all.reduce((n, f) => n + f.size, 0)
  console.log(`\n✅ 构建完成 → ${path.relative(ROOT, OUT_DIR)}/\n`)
  const width = Math.max(...all.map((f) => f.rel.length), 24)
  for (const f of all) {
    let extra = ''
    if (f.rel.endsWith('.wasm')) {
      const gz = gzipSync(await readFile(f.full), { level: 9 }).length
      extra = `  (gzip ${human(gz)})`
    }
    console.log(`   ${f.rel.padEnd(width)}  ${human(f.size).padStart(9)}${extra}`)
  }
  console.log(`\n   合计 ${human(total)}，共 ${all.length} 个文件`)
  if (COPY_TO) console.log(`   已同步 → ${COPY_TO}`)
  console.log('\n   拷贝整个文件夹到目标项目即可使用，详见 README.md')
}

main().catch((err) => {
  console.error('\n✗ 构建失败：', err.message)
  process.exit(1)
})
