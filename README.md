# image-engine

浏览器端高性能图片处理引擎。基于 **wasm-vips**（libvips 的 WebAssembly 版本），
零依赖、零上传，缩放 / 裁剪 / 旋转 / 格式转换全部在用户设备上完成。

**整个文件夹可以原样拷进任何项目**，不需要 npm 安装，不需要打包器配置。

> ⚠️ **前置条件**：浏览器端运行时需要页面处于跨源隔离状态，也就是必须能设置
> `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` 两个响应头。
> 配置方法见 [第 6 节](#6-响应头要求必读)，**没配的话引擎会直接报 `NOT_CROSS_ORIGIN_ISOLATED`**。
> Node.js 环境没有这个限制。

---

## 1. 30 秒接入

### 方式 A：传统 `<script>`（最省事）

把这个文件夹放到站点的静态目录（例如 `public/image-engine/`），然后：

```html
<script src="/image-engine/image-engine.js"></script>
<script>
  const engine = await ImageEngine.create()

  const out = await engine.process(file, [
    { op: 'resize', width: 1200, fit: 'inside' },
    { op: 'crop', left: 0, top: 0, width: 800, height: 600 },
  ], { format: 'webp', quality: 80 })

  img.src = URL.createObjectURL(out.blob)
</script>
```

> 脚本会自动推断自身所在目录，从而找到 `worker.js` 与 `vendor/*.wasm`。
> 如果脚本是动态注入的（拿不到自身 URL），给标签加 `data-base`：
> `<script src="/libs/image-engine/image-engine.js" data-base="/libs/image-engine/"></script>`

### 方式 B：ESM import

```js
import { createImageEngine } from '/image-engine/index.js'

const engine = await createImageEngine()
const out = await engine.convert(file, { format: 'avif', quality: 55 })
```

### 方式 C：Node.js

```js
import { createImageEngine } from './image-engine/index.js'

const engine = await createImageEngine()
const out = await engine.resize(await readFile('in.jpg'), { width: 800 })
await writeFile('out.webp', out.buffer)
```

Node 环境没有 `Worker`，会自动退化为直连模式，API 完全一致。

### 先在本地试一下

因为必须带 COOP/COEP 响应头，**直接双击打开 `index.html`（file://）或普通静态服务器都不行**。
把下面这段存成 `serve.mjs`，和本文件夹放同级目录，运行 `node serve.mjs` 再打开
<http://127.0.0.1:8787/> 即可：

```js
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = new URL('./image-engine/', import.meta.url).pathname
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }

http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.js'
  const file = path.join(ROOT, rel)
  if (!file.startsWith(ROOT)) { res.writeHead(403, HEADERS); return res.end() }
  try {
    const data = await readFile(file)
    res.writeHead(200, { ...HEADERS, 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html>打开控制台执行：await (await import("/index.js")).createImageEngine()')
  }
}).listen(8787, '127.0.0.1', () => console.log('http://127.0.0.1:8787/'))
```

然后在浏览器控制台里：

```js
const { createImageEngine } = await import('/index.js')
const engine = await createImageEngine()      // 打印 engine.mode，应为 'worker'
const out = await engine.convert(new Uint8Array([...]), { format: 'webp' })
```

---

## 2. 创建引擎

```js
const engine = await createImageEngine(options?)
```

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workers` | `number` | `min(核数, 4)` | Worker 数量。`0` = 不用 Worker，主线程直连 |
| `workerUrl` | `string \| URL` | 本模块同目录的 `worker.js` | 自定义 Worker 地址（打包器场景常用） |
| `wasmBase` | `string` | 胶水代码同目录 | 自定义 wasm 目录（把 wasm 放 CDN 时用） |
| `svg` | `boolean` | `false` | 启用 SVG 输入（需 `vendor/vips-resvg.wasm`） |
| `threads` | `number` | 见下 | libvips 内部线程数 |
| `locateFile` | `function` | — | 自定义 wasm 定位，**仅直连模式生效**（函数无法跨线程传递） |

**线程策略**：池里有多个 Worker 时，每个 Worker 只用 1 个 libvips 线程（避免线程超订）；
只有 1 个 Worker 时，它吃满所有核。

### 引擎实例

| 成员 | 说明 |
|---|---|
| `mode` | `'worker'`（Worker 池）或 `'direct'`（主线程直连） |
| `size` | Worker 池大小，`direct` 恒为 `1` |
| `destroy()` | 终止所有 Worker、释放 WASM 资源 |

---

## 3. 处理图片

### `engine.process(source, ops?, output?)`

最完整的形式。`source` 支持 `File` / `Blob` / `ArrayBuffer` / `Uint8Array`。

```js
const out = await engine.process(file, [
  { op: 'autorot' },                                        // EXIF 摆正
  { op: 'resize', width: 1600, height: 900, fit: 'cover' }, // 缩放
  { op: 'crop', left: 100, top: 50, width: 600, height: 600 },
  { op: 'rotate', angle: 90 },
], {
  format: 'webp',
  quality: 82,
})
```

整个 `ops` 数组会被翻译成 **一条 libvips 管线**：只解码一次、只编码一次，
中间结果不落地。这是它比「每步各调一次库」快得多的原因。

### 语法糖

| 方法 | 等价于 |
|---|---|
| `engine.resize(source, opts)` | `process(source, [{ op:'resize', ...opts }], opts.output)` |
| `engine.crop(source, opts)` | `process(source, [{ op:'crop', ...opts }], opts.output)` |
| `engine.convert(source, output?)` | `process(source, [], output)` |
| `engine.metadata(source)` | 只读元信息，不解码像素 |

```js
const meta = await engine.metadata(file)
// { width, height, bands, hasAlpha, pixelFormat, interpretation, pages, sourceFormat }
```

### 操作（ops）

按数组顺序依次执行。

| op | 参数 | 说明 |
|---|---|---|
| `autorot` | — | 按 EXIF 方向摆正。**默认已自动执行**，无需手写 |
| `resize` | `width` `height` `fit` `kernel` `upscale` | 缩放，见下表 |
| `crop` | `left` `top` `width` `height` | 裁剪，越界会抛 `OUT_OF_BOUNDS` |
| `rotate` | `angle` | 仅 `0` / `90` / `180` / `270` |
| `flip` | — | 上下翻转 |
| `flop` | — | 左右翻转 |

**`resize.fit` 取值**

| 值 | 行为 |
|---|---|
| `'inside'`（默认） | 完整放进 `width×height`，保持比例，默认不放大 |
| `'cover'` | 填满 `width×height`，保持比例，超出部分居中裁掉 |
| `'fill'` | 拉伸到精确的 `width×height`，不保持比例 |

`kernel` 默认 `'lanczos3'`，可选 `nearest` / `linear` / `cubic` / `mitchell` / `lanczos2`。

### 输出选项（output）

| 选项 | 适用 | 说明 |
|---|---|---|
| `format` | 全部 | `jpeg` `png` `webp` `avif` `gif` `tiff` `jxl`；省略则保持源格式 |
| `quality` | jpeg/webp/avif/jxl | 1-100。默认：jpeg 85、webp 80、avif 60、jxl 80 |
| `progressive` | jpeg/png/gif | 渐进式 / 交错 |
| `lossless` | webp/avif/jxl/tiff | 无损模式 |
| `effort` | webp/avif/jxl/gif | 编码投入度，越高越小越慢。默认 webp 4、avif 4、jxl 5、gif 7 |
| `compressionLevel` | png | 0-9，默认 6 |
| `palette` | png | 转 8 位调色板（此时 `quality` 才生效） |
| `chromaSubsampling` | jpeg | `auto` / `on` / `off` / `q4` |
| `keepMetadata` | 全部 | `true` 保留 EXIF/ICC 等；默认 `false`，剥掉更小 |
| `autorotate` | 全部 | `false` 关闭默认的 EXIF 摆正 |
| `options` | 全部 | 逃生舱：直接透传任意 libvips 保存选项 |

```js
// 想用 libvips 原生选项又没被上面的表覆盖，直接透传
await engine.convert(file, { format: 'jpeg', options: { trellis_quant: true, optimize_scans: true } })
```

### 返回值

```js
{
  buffer,   // Uint8Array，输出字节
  blob,     // Blob（浏览器），Node 下为 null
  width,    // 输出宽
  height,   // 输出高
  size,     // 字节数
  format,   // 'webp'
  mime,     // 'image/webp'
  type,     // mime 的别名
}
```

常见后续动作：

```js
URL.createObjectURL(out.blob)                       // 预览
fetch('/upload', { method:'POST', body: out.blob }) // 上传
const a = document.createElement('a'); a.href = URL.createObjectURL(out.blob); a.download = `x.${out.format}`; a.click()
```

---

## 4. 错误处理

所有异常都是 `EngineError`，带稳定的 `code`，建议按 `code` 分支而不是解析文案。

```js
import { EngineError } from '/image-engine/index.js'

try {
  await engine.process(file, [{ op: 'crop', left: 0, top: 0, width: 99999, height: 10 }])
} catch (err) {
  if (err instanceof EngineError && err.code === 'OUT_OF_BOUNDS') { /* ... */ }
}
```

| code | 含义 |
|---|---|
| `BAD_INPUT` | 输入类型不对（例如传了路径字符串） |
| `BAD_OP` | 操作不合法（未知 op、旋转角度不是 90 的倍数） |
| `OUT_OF_BOUNDS` | 裁剪区域超出图像边界 |
| `UNSUPPORTED_FORMAT` | 目标格式不支持（含试图输出 HEIC 的情况） |
| `WORKER_ERROR` | Worker 内部崩溃 |
| `NOT_CROSS_ORIGIN_ISOLATED` | 缺少 COOP/COEP 响应头（见第 6 节） |
| `DESTROYED` | 引擎已 `destroy()` 后继续调用 |
| `UNSUPPORTED_ENV` | 环境没有 WebAssembly |

---

## 5. 格式支持

| 格式 | 解码（输入） | 编码（输出） | 备注 |
|---|:---:|:---:|---|
| JPEG | ✅ | ✅ | mozjpeg，`optimize_coding` 默认开 |
| PNG | ✅ | ✅ | 无损；`palette: true` 可转调色板 |
| WebP | ✅ | ✅ | 支持无损 |
| AVIF | ✅ | ✅ | 走 `vips-heif.wasm` 动态模块 |
| GIF | ✅ | ✅ | 多帧图默认只取第一帧 |
| TIFF | ✅ | ✅ | |
| JPEG XL | ✅ | ✅ | 走 `vips-jxl.wasm` 动态模块 |
| SVG | ⚠️ 需 `svg: true` | ❌ | 需 `vips-resvg.wasm` |
| **HEIC / HEIF（HEVC）** | ❌ | ❌ | 见下 |

**关于 HEIC**：HEIC 用 HEVC 编码，HEVC 有专利授权问题，WASM 包不带 HEVC 解码器/编码器，
这是整个行业的做法（Chromium、WordPress 的客户端图像处理都是这么绕开的）。
浏览器里处理 HEIC 只能走平台解码兜底：

```js
// Safari 可直接解码；Chromium 需要平台 HEVC 支持
const bitmap = await createImageBitmap(heicFile)     // 失败就走下面的分支
const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
canvas.getContext('2d').drawImage(bitmap, 0, 0)
const png = await canvas.convertToBlob({ type: 'image/png' })
// 拿到 png 后再交给 image-engine 继续缩放 / 压缩
```

---

## 6. 响应头要求（必读）

libvips 的 WASM 构建带 pthreads，创建线程池时要把 `SharedArrayBuffer` 交给子 Worker，
这要求页面处于**跨源隔离（cross-origin isolated）**状态。**没有隔离时引擎无法初始化**，
会抛出 `NOT_CROSS_ORIGIN_ISOLATED`（而不是悄悄降级），请务必配好响应头。

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- 这两个头要加在**页面**的响应上；`/image-engine/*` 是同源资源，不需要额外处理。
- 只对用到图片工具的路径加也可以（例如只给 `/tools/image*` 加），不必全站开。
- Chromium 137+ 也可用更轻的 `Document-Isolation-Policy: isolate-and-credentialless`，
  它不要求跨域资源带 CORP 头，对其他第三方资源更友好。
- `COEP: require-corp` 会让**跨域**图片 / 脚本 / iframe 被拦截，对方必须带
  `Cross-Origin-Resource-Policy: cross-origin`。如果你的站点大量引用跨域资源，
  建议只给图片工具页面单独加头，或改用 `Document-Isolation-Policy`。

各环境配置方式：

```nginx
# Nginx：只给图片工具路径加
location /tools/image {
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
}
```

```
# Netlify / Cloudflare Pages 的 _headers
/tools/image/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

```js
// Astro dev server（astro.config.mjs）—— 本地开发也要加，否则一样起不来
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
```

> **如果你的托管平台完全无法自定义响应头**，那么浏览器端方案走不通，只能退回服务端处理
> （Node 里可以用本工具包的直连模式，或用原生 sharp）。这一点没有别的绕法。

---

## 7. 运行环境与体积

构建脚本会打印每个文件的原始体积与 gzip 体积。

| 文件 | 作用 | 是否必需 |
|---|---|---|
| `vendor/vips.wasm` | 核心运行时（JPEG/PNG/WebP/GIF/TIFF） | **必需** |
| `vendor/vips-es6.js` | 浏览器胶水 | **必需** |
| `vendor/vips-node.mjs` | Node 胶水 | 仅 Node 需要 |
| `vendor/vips-heif.wasm` | AVIF | 用才下载 |
| `vendor/vips-jxl.wasm` | JPEG XL | 用才下载 |
| `vendor/vips-resvg.wasm` | SVG | 用才下载 |

动态模块只有在 `dynamicLibraries` 里列出来时才会被请求，所以「不用 AVIF/JXL/SVG」
可以直接删掉对应的 wasm 文件并改 `loader.js` 里的默认列表，首屏体积会小很多。

**服务器请开启 gzip / brotli**，wasm 压缩比很高。

---

## 8. 目录结构

### 分发产物（`npm run build` 生成，拷走的是这个）

```
dist/image-engine/
├── index.js           # 对外入口（ESM）
├── index.d.ts         # TypeScript 类型
├── image-engine.js    # 传统 <script> 引入版（暴露 window.ImageEngine）
├── worker.js          # Web Worker
├── loader.js          # vips 加载器
├── ops.js             # 操作管线
├── package.json       # 使本目录按 ESM 解析
├── manifest.json      # 构建信息（版本 / 文件清单）
├── README.md
├── LICENSE
├── THIRD-PARTY-NOTICES.md
└── vendor/
    ├── vips-es6.js
    ├── vips-node.mjs
    ├── vips.wasm
    ├── vips-heif.wasm
    ├── vips-jxl.wasm
    └── vips-resvg.wasm
```

**拷贝时请整个文件夹一起拷**，`index.js`、`worker.js`、`vendor/` 三者的相对位置不能变。

### 本仓库

```
imgproc/
├── src/               # 工具包源码（纯 ESM JS，无打包器；产物 = 原样拷贝 + 附上 wasm）
│   ├── index.js
│   ├── image-engine.js
│   ├── worker.js
│   ├── loader.js
│   ├── ops.js
│   └── index.d.ts
├── scripts/
│   ├── build.mjs          # 构建：拷贝源码 + 拉取 wasm-vips + 生成 package.json/manifest.json
│   ├── test-node.mjs      # Node 直连回归（38 项断言）
│   ├── test-browser.mjs   # 无头 Chrome + CDP 回归（有/无 COOP-COEP 两条路径）
│   ├── serve-demo.mjs     # 本地试用页
│   └── lib/make-png.mjs   # 测试用：纯 Node 造 PNG
├── README.md          # 本文件（唯一来源，构建时一并拷进产物）
└── package.json
```

---

## 9. 开发本仓库

本仓库**零 npm 依赖**，只需要 Node ≥ 22（构建时从 registry 拉一次 wasm-vips，之后走 `.cache/`）。

```bash
npm run build                # 产出 dist/image-engine/
npm run build -- --copy-to ../toolsite/public/image-engine   # 顺手同步到消费方
npm test                     # Node 回归（38 项断言）
npm run test:browser         # 无头 Chrome 回归（需本机有 Chrome；沙箱内需 --no-sandbox，脚本已带）
npm run demo                 # 起本地试用页 http://127.0.0.1:8787/
```

几点约定：

- **`dist/` 不入库**（12MB，含第三方 wasm 二进制）。要给别人用就 `--copy-to` 到目标项目，
  或把产物打包成 Release 附件。
- 升级 libvips：`WASM_VIPS_VERSION=0.0.20 npm run build`，构建脚本会去 registry 取新版本并重新解包。
- 改完 `src/` 后**务必跑 `npm test` + `npm run test:browser`**：浏览器那条链路会抓出
  Node 侧覆盖不到的问题（Worker 池、跨源隔离、资源按路径加载）。
- 新增输出格式时，除了 `src/ops.js` 的 `SUFFIX_BY_FORMAT` / `buildSaveOptions`，
  记得同步 README 第 5 节与本文件第 3 节的选项表。

---

## 10. 许可

引擎基于 [libvips](https://www.libvips.org/) / [wasm-vips](https://github.com/kleisauke/wasm-vips)（MIT）。
随包的 `LICENSE` 与 `THIRD-PARTY-NOTICES.md` 为 wasm-vips 及其依赖方的许可声明，请一并保留。

