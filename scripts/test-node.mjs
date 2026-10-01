#!/usr/bin/env node
/**
 * image-engine 冒烟测试（Node 直连模式）
 *
 * 验证构建产物 dist/image-engine 能独立跑通：缩放 / 裁剪 / 旋转 / 换取格式 / 错误处理。
 * 源图由脚本自己用 zlib 现造一张 PNG，不依赖任何外部图片或第三方库。
 *
 * 用法：pnpm test（或 node scripts/test-node.mjs）
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makePng } from './lib/make-png.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(ROOT, 'dist', 'image-engine', 'index.js')

/* ─────────────── 断言工具 ─────────────── */

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  → ' + extra : ''}`)
  }
}

async function checkThrows(name, fn, code) {
  try {
    await fn()
    check(name, false, `预期抛出 ${code}，但成功了`)
  } catch (err) {
    check(name, err.code === code, `期望 code=${code}，实际 code=${err.code} / ${err.message}`)
  }
}

/* ─────────────── 主流程 ─────────────── */

if (!existsSync(ENTRY)) {
  console.error(`✗ 找不到构建产物 ${ENTRY}\n  请先执行：pnpm build`)
  process.exit(1)
}

const { createImageEngine, EngineError, isSupported } = await import(ENTRY)

const SRC_W = 800
const SRC_H = 600
const source = makePng(SRC_W, SRC_H)

console.log('\nimage-engine 冒烟测试\n')
console.log(`源图：${SRC_W}×${SRC_H} PNG，${(source.length / 1024).toFixed(1)} KB\n`)

check('环境支持 WebAssembly', isSupported())

const engine = await createImageEngine()
console.log(`  引擎模式：${engine.mode}（池大小 ${engine.size}）\n`)

/* 1. 元信息 */
console.log('元信息')
{
  const meta = await engine.metadata(source)
  check('读取宽高', meta.width === SRC_W && meta.height === SRC_H, JSON.stringify(meta))
  check('识别源格式为 png', meta.sourceFormat === 'png')
}

/* 2. 缩放 */
console.log('\n缩放')
{
  const inside = await engine.resize(source, { width: 200 })
  check('inside：宽为 200', inside.width === 200, `${inside.width}`)
  check('inside：等比高为 150', inside.height === 150, `${inside.height}`)
  check('未指定 format 时保持 png', inside.format === 'png', inside.format)

  const cover = await engine.resize(source, { width: 300, height: 300, fit: 'cover' })
  check('cover：精确 300×300', cover.width === 300 && cover.height === 300, `${cover.width}×${cover.height}`)

  const fill = await engine.resize(source, { width: 320, height: 240, fit: 'fill' })
  check('fill：精确 320×240', fill.width === 320 && fill.height === 240, `${fill.width}×${fill.height}`)

  const noUpscale = await engine.resize(source, { width: 5000 })
  check('默认不放大', noUpscale.width === SRC_W, `${noUpscale.width}`)

  const up = await engine.resize(source, { width: 1600, upscale: true })
  check('upscale:true 可放大', up.width === 1600, `${up.width}`)
}

/* 3. 裁剪 */
console.log('\n裁剪')
{
  const out = await engine.crop(source, { left: 100, top: 50, width: 300, height: 200 })
  check('裁剪得到 300×200', out.width === 300 && out.height === 200, `${out.width}×${out.height}`)

  await checkThrows(
    '越界裁剪抛 OUT_OF_BOUNDS',
    () => engine.crop(source, { left: 700, top: 0, width: 300, height: 100 }),
    'OUT_OF_BOUNDS',
  )
}

/* 4. 旋转 / 翻转 */
console.log('\n旋转与翻转')
{
  const rot = await engine.process(source, [{ op: 'rotate', angle: 90 }])
  check('旋转 90° 后宽高互换', rot.width === SRC_H && rot.height === SRC_W, `${rot.width}×${rot.height}`)

  const flip = await engine.process(source, [{ op: 'flip' }])
  check('上下翻转尺寸不变', flip.width === SRC_W && flip.height === SRC_H)
}

/* 5. 组合管线 */
console.log('\n组合管线')
{
  const out = await engine.process(
    source,
    [
      { op: 'resize', width: 400, height: 400, fit: 'cover' },
      { op: 'rotate', angle: 90 },
      { op: 'crop', left: 0, top: 0, width: 200, height: 100 },
    ],
    { format: 'webp', quality: 78 },
  )
  check('组合管线输出 200×100 webp', out.width === 200 && out.height === 100 && out.format === 'webp',
    `${out.width}×${out.height} ${out.format}`)
  check('mime 正确', out.mime === 'image/webp', out.mime)
  check('blob 生成且类型正确', out.blob === null || out.blob.type === 'image/webp')
}

/* 6. 各格式编码 + 回读验证 */
console.log('\n格式转换（编码后回读校验）')
for (const [format, output] of [
  ['jpeg', { format: 'jpeg', quality: 82 }],
  ['webp', { format: 'webp', quality: 75 }],
  ['avif', { format: 'avif', quality: 55 }],
  ['png', { format: 'png', compressionLevel: 9 }],
  ['gif', { format: 'gif' }],
  ['tiff', { format: 'tiff' }],
  ['jxl', { format: 'jxl', quality: 80 }],
]) {
  try {
    const out = await engine.convert(source, output)
    const back = await engine.metadata(out.buffer)
    const ok = out.format === format && back.width === SRC_W && back.height === SRC_H
    check(
      `${format}：编码 ${(out.size / 1024).toFixed(1)} KB 且可回读`,
      ok,
      `format=${out.format} 回读=${back.width}×${back.height}`,
    )
  } catch (err) {
    check(`${format}：编码且可回读`, false, err.message)
  }
}

/* 7. 无损与元数据 */
console.log('\n编码选项')
{
  const lossless = await engine.convert(source, { format: 'webp', lossless: true })
  check('webp 无损', lossless.format === 'webp' && lossless.size > 0)

  const kept = await engine.convert(source, { format: 'jpeg', quality: 90, keepMetadata: true })
  check('keepMetadata:true 可用', kept.size > 0)

  const raw = await engine.convert(source, { format: 'jpeg', options: { trellis_quant: true } })
  check('options 逃生舱透传', raw.size > 0)
}

/* 8. 错误处理 */
console.log('\n错误处理')
{
  await checkThrows('不支持的输入类型', () => engine.convert('/some/path.jpg'), 'BAD_INPUT')
  await checkThrows('未知操作', () => engine.process(source, [{ op: 'nope' }]), 'BAD_OP')
  await checkThrows('非法旋转角度', () => engine.process(source, [{ op: 'rotate', angle: 45 }]), 'BAD_OP')
  await checkThrows('输出 HEIC 给出明确提示', () => engine.convert(source, { format: 'heic' }), 'UNSUPPORTED_FORMAT')
  await checkThrows('未知输出格式', () => engine.convert(source, { format: 'psd' }), 'UNSUPPORTED_FORMAT')

  try {
    await engine.convert(source, { format: 'heic' })
  } catch (err) {
    check('错误是 EngineError 实例', err instanceof EngineError)
    check('HEIC 提示含 HEVC 说明', /HEVC/.test(err.message), err.message)
  }
}

/* 9. 输入形态兼容 */
console.log('\n输入形态')
{
  const fromArrayBuffer = await engine.convert(source.buffer.slice(0), { format: 'png' })
  check('ArrayBuffer 输入', fromArrayBuffer.format === 'png')

  const asBlob = new Blob([source], { type: 'image/png' })
  const fromBlob = await engine.convert(asBlob, { format: 'png' })
  check('Blob 输入', fromBlob.format === 'png')

  // 子视图：故意在前后各加多余字节，验证 byteOffset 处理正确
  const padded = new Uint8Array(source.length + 16)
  padded.set(source, 8)
  const sub = padded.subarray(8, 8 + source.length)
  const fromSub = await engine.metadata(sub)
  check('带偏移的子视图输入', fromSub.width === SRC_W && fromSub.height === SRC_H, JSON.stringify(fromSub))
}

/* 10. 销毁 */
console.log('\n销毁')
{
  engine.destroy()
  await checkThrows('destroy 后调用被拒（DESTROYED）', () => engine.convert(source, { format: 'png' }), 'DESTROYED')
}

/* ─────────────── 汇总 ─────────────── */

console.log(`\n${'─'.repeat(48)}`)
if (failed === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m：${passed} 项断言`)
} else {
  console.log(`\x1b[31m失败 ${failed} 项\x1b[0m / 通过 ${passed} 项`)
  console.log('失败项：\n' + failures.map((f) => '  - ' + f).join('\n'))
}
process.exit(failed === 0 ? 0 : 1)
