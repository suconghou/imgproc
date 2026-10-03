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

/* 10. 透明合成（#1） */
// 用 vendor 里的 vips 现造 RGBA 输入并回读像素（仅测试用）
const vips = await (await import(path.join(ROOT, 'dist', 'image-engine', 'vendor', 'vips-node.mjs'))).default()

/** 造一张 RGBA PNG：RGB 恒为红，alpha 按列分档 0 / 128 / 255 */
function makeRgbaPng(width, height) {
  const alphas = Array.from({ length: width }, (_, x) =>
    x < width / 3 ? 0 : x < (width * 2) / 3 ? 128 : 255)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = alphas[x]
    }
  }
  return new Uint8Array(vips.Image.newFromMemory(data, width, height, 4, 'uchar').writeToBuffer('.png'))
}

/** 回读多帧信息：必须用 n=-1，否则只能看到第一帧 */
function inspect(buf) {
  const im = vips.Image.newFromBuffer(new Uint8Array(buf), 'n=-1')
  const ph = im.pageHeight > 0 ? im.pageHeight : im.height
  return { pages: Math.max(1, Math.round(im.height / ph)), pageHeight: ph, width: im.width, height: im.height }
}

const rgbaPng = makeRgbaPng(6, 2)
const rgbaMeta = await engine.metadata(rgbaPng)

console.log('\n透明合成')
{
  check('RGBA 输入被识别为带 alpha', rgbaMeta.hasAlpha === true, `hasAlpha=${rgbaMeta.hasAlpha}`)

  const out = await engine.convert(rgbaPng, { format: 'jpeg', quality: 95 })
  const px = vips.Image.newFromBuffer(new Uint8Array(out.buffer)).getpoint(0, 0)
  check('转 JPEG 时透明区自动合成白底（不再是黑底）', px[0] > 240 && px[1] > 240 && px[2] > 240, `[${px.join(', ')}]`)

  const dark = await engine.convert(rgbaPng, { format: 'jpeg', quality: 95, background: '#000000' })
  const pxDark = vips.Image.newFromBuffer(new Uint8Array(dark.buffer)).getpoint(0, 0)
  check('background 可指定背景色', pxDark[0] < 15 && pxDark[1] < 15, `[${pxDark.join(', ')}]`)

  const green = await engine.process(rgbaPng, [{ op: 'flatten', background: '#00ff00' }], { format: 'png' })
  const backGreen = vips.Image.newFromBuffer(new Uint8Array(green.buffer))
  check('flatten 操作可用（合成绿底并去掉 alpha）',
    backGreen.bands === 3 && backGreen.getpoint(0, 0)[1] > 240,
    `bands=${backGreen.bands} [${backGreen.getpoint(0, 0).join(', ')}]`)

  const off = await engine.convert(rgbaPng, { format: 'jpeg', quality: 95, flatten: false })
  const pxOff = vips.Image.newFromBuffer(new Uint8Array(off.buffer)).getpoint(0, 0)
  check('flatten:false 可退回旧行为', pxOff[0] < 15, `[${pxOff.join(', ')}]`)
}

/* 11. 目标体积（#2） */
console.log('\n目标体积')
{
  const target = 20 * 1024
  const webp = await engine.convert(source, { format: 'webp', targetSize: target })
  check('webp 走原生 target_size 命中', webp.size <= target,
    `${(webp.size / 1024).toFixed(1)} KB ≤ 20 KB`)

  const jpeg = await engine.convert(source, { format: 'jpeg', targetSize: '15kb' })
  check("jpeg 二分逼近命中（'15kb' 字符串）", jpeg.size <= 15 * 1024,
    `${(jpeg.size / 1024).toFixed(1)} KB ≤ 15 KB, quality=${jpeg.quality}`)

  const avif = await engine.convert(source, { format: 'avif', targetSize: 12 * 1024 })
  check('avif 二分逼近命中', avif.size <= 12 * 1024, `${(avif.size / 1024).toFixed(1)} KB`)

  const qualityMode = await engine.convert(source, { format: 'jpeg', quality: 82 })
  check('不传 targetSize 时 quality 仍生效', qualityMode.size > 0 && qualityMode.quality === 82)

  await checkThrows('无损格式要求 targetSize 时给明确报错',
    () => engine.convert(source, { format: 'png', targetSize: 4096 }), 'UNSUPPORTED_OPTION')
}

/* 12. 动图保留（#5） */
console.log('\n动图')
{
  // 造一张 2 帧 GIF：两帧竖着拼起来，用 page_height 切分
  const FW = 32
  const FH = 24
  const raw = new Uint8Array(FW * FH * 2 * 3)
  for (let f = 0; f < 2; f++) {
    for (let i = 0; i < FW * FH; i++) {
      const o = (f * FW * FH + i) * 3
      raw[o] = f === 0 ? 255 : 0
      raw[o + 1] = f === 0 ? 0 : 255
    }
  }
  const animGif = new Uint8Array(
    vips.Image.newFromMemory(raw, FW, FH * 2, 3, 'uchar').writeToBuffer('.gif', { page_height: FH }))

  const animMeta = await engine.metadata(animGif)
  check('元信息能读出真实帧数', animMeta.pages === 2 && animMeta.animated === true,
    `pages=${animMeta.pages} frameHeight=${animMeta.frameHeight}`)

  const off = await engine.convert(animGif, { format: 'webp', quality: 80 })
  check('默认只取第一帧', off.frames === 1 && off.animated === false, `frames=${off.frames}`)

  const on = await engine.convert(animGif, { format: 'webp', quality: 80, animated: true })
  check('animated:true 转 webp 保留 2 帧', on.frames === 2 && inspect(on.buffer).pages === 2,
    `frames=${on.frames} 回读=${inspect(on.buffer).pages}`)

  const resized = await engine.process(animGif, [{ op: 'resize', width: 16 }], { format: 'gif', animated: true })
  const rb = inspect(resized.buffer)
  check('动图 + resize 保持多帧与 page-height', resized.frames === 2 && rb.pages === 2 && resized.width === 16,
    `frames=${resized.frames} ${resized.width}x${resized.height} pageH=${rb.pageHeight}`)

  await checkThrows('动图 + 裁剪给明确报错',
    () => engine.process(animGif, [{ op: 'crop', left: 0, top: 0, width: 8, height: 8 }], { format: 'gif', animated: true }),
    'UNSUPPORTED_OPTION')
  await checkThrows('动图输出到 jpeg 给明确报错',
    () => engine.convert(animGif, { format: 'jpeg', animated: true }), 'UNSUPPORTED_OPTION')
}

/* 13. 进度回调（#3，直连模式） */
console.log('\n进度回调')
{
  const seen = []
  const out = await engine.process(source, [{ op: 'resize', width: 400 }], {
    format: 'jpeg',
    quality: 80,
    onProgress: (p) => seen.push(p),
  })
  check('onProgress 被回调到', seen.length > 0, `收到 ${seen.length} 次`)
  check('进度值都落在 0-100', seen.every((p) => p >= 0 && p <= 100), JSON.stringify(seen.slice(0, 6)))
  check('最后一次进度是 100', seen[seen.length - 1] === 100, `最后 ${seen[seen.length - 1]}`)
  check('进度不影响结果', out.size > 0 && out.format === 'jpeg')
}

/* 14. 取消（#4，直连模式的信号前置检查） */
console.log('\n取消')
{
  const ac = new AbortController()
  ac.abort()
  await checkThrows('已取消的 signal 会立即拒绝',
    () => engine.process(source, [], { format: 'png' }, { signal: ac.signal }), 'ABORTED')

  const ok2 = new AbortController()
  const out = await engine.process(source, [], { format: 'png' }, { signal: ok2.signal })
  check('未取消的 signal 不影响处理', out.size > 0)
}

/* 15. 销毁 */
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
