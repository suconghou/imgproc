/**
 * image-engine · 类型定义
 *
 * 该文件与 index.js 同级，随工具包一起分发。
 */

/** 可产出的格式 */
export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'tiff' | 'jxl'

/** 缩放适配方式 */
export type FitMode = 'inside' | 'cover' | 'fill'

/** 重采样核 */
export type Kernel =
  | 'nearest'
  | 'linear'
  | 'cubic'
  | 'mitchell'
  | 'lanczos2'
  | 'lanczos3'

/** 可接受的输入 */
export type ImageSource = Blob | ArrayBuffer | ArrayBufferView

/** 缩放 */
export interface ResizeOp {
  op: 'resize'
  /** 目标宽（与 height 至少给一个） */
  width?: number
  /** 目标高 */
  height?: number
  /**
   * 适配方式，默认 'inside'
   * - inside：完整放入宽高框内，保持比例（不放大）
   * - cover：填满宽高框，保持比例，超出部分居中裁掉
   * - fill：拉伸到精确宽高，不保比例
   */
  fit?: FitMode
  /** 重采样核，默认 'lanczos3' */
  kernel?: Kernel
  /** 是否允许放大，默认 false */
  upscale?: boolean
}

/** 裁剪 */
export interface CropOp {
  op: 'crop'
  left: number
  top: number
  width: number
  height: number
}

/** 旋转（仅支持 0 / 90 / 180 / 270） */
export interface RotateOp {
  op: 'rotate'
  angle: 0 | 90 | 180 | 270
}

/** 无参数操作：EXIF 摆正 / 上下翻 / 左右翻 */
export interface SimpleOp {
  op: 'autorot' | 'flip' | 'flop'
}

/** 把透明区合成到背景色（图像无 alpha 时原样返回） */
export interface FlattenOp {
  op: 'flatten'
  /** '#rgb' / '#rrggbb' / 'white' / 'black' / [r,g,b]，默认 '#ffffff' */
  background?: string | number[]
}

export type Operation = ResizeOp | CropOp | RotateOp | SimpleOp | FlattenOp

/** 输出编码选项 */
export interface OutputOptions {
  /** 目标格式；省略则保持源格式 */
  format?: OutputFormat
  /** 有损质量 1-100（png 仅在 palette 模式生效） */
  quality?: number
  /**
   * 目标体积。数字（字节）或 '200kb' / '1.5mb' 这类字符串。
   * - webp：走 libwebp 原生 target_size，精确且快（此时 quality 被忽略）
   * - jpeg / avif / jxl：在引擎内二分 quality 逼近（会多编码几次）
   * - png / gif / tiff：无损格式无法按体积收敛，会抛 UNSUPPORTED_OPTION
   */
  targetSize?: number | string
  /** webp 走 target_size 时的编码遍数，默认 6 */
  passes?: number
  /** 渐进式 / 交错 */
  progressive?: boolean
  /** webp / avif / jxl 无损模式 */
  lossless?: boolean
  /** 编码投入度：webp 0-6，avif 0-9，jxl 1-9，gif 1-10 */
  effort?: number
  /** png 压缩级别 0-9，默认 6 */
  compressionLevel?: number
  /** png 转 8 位调色板 */
  palette?: boolean
  /** JPEG 色度采样 */
  chromaSubsampling?: 'auto' | 'on' | 'off' | 'q4'
  /** 是否保留 EXIF/ICC 等元数据，默认 false（剥掉，体积更小） */
  keepMetadata?: boolean
  /** 是否按 EXIF 方向自动摆正，默认 true */
  autorotate?: boolean
  /**
   * 透明区合成用的背景色，默认 '#ffffff'。
   * 目标格式不含 alpha（jpeg）时会自动合成，否则 libvips 会按黑底合成得到黑底图。
   */
  background?: string | number[]
  /** 是否自动合成背景；jpeg 默认 true，可显式传 false 关闭 */
  flatten?: boolean
  /**
   * 是否保留动图的多帧，默认 false（只取第一帧）。开启后：
   * - 输出格式只支持 gif / webp / avif
   * - 只允许 resize（可附带 autorot / flatten），裁剪 / 旋转会破坏多帧结构
   * - 会载入全部帧，内存与耗时随帧数上升
   */
  animated?: boolean
  /**
   * 进度回调，0-100。在主线程被调用，不会传入 Worker。
   * 直连模式（Node / 无 Worker）下同步触发。
   */
  onProgress?: (percent: number) => void
  /** 逃生舱：直接透传任意 libvips 保存选项 */
  options?: Record<string, unknown>
}

/** process 的运行时控制项 */
export interface ProcessControl {
  /** 用于中途取消。取消会终止并重建该 Worker，下一次调用需重新初始化 wasm（约 1-3s） */
  signal?: AbortSignal
}

/** 处理结果 */
export interface ProcessResult {
  /** 输出字节 */
  buffer: Uint8Array
  /** 输出 Blob（浏览器环境；Node 下为 null） */
  blob: Blob | null
  width: number
  /** 多帧时是所有帧拼起来的总高度 */
  height: number
  /** 单帧高度 */
  frameHeight: number
  /** 帧数，> 1 表示动图 */
  frames: number
  animated: boolean
  /** 实际使用的 quality；webp 走 targetSize 时为 null，未指定时为 undefined */
  quality?: number | null
  /** 字节数 */
  size: number
  format: OutputFormat
  mime: string
  /** mime 的别名，便于直接塞给 Blob/上传接口 */
  type: string
}

/** 元信息 */
export interface ImageMetadata {
  width: number
  height: number
  bands: number
  hasAlpha: boolean
  pixelFormat: string
  interpretation: string
  pages: number
  sourceFormat: string | null
}

/** 引擎选项 */
export interface EngineOptions {
  /** Worker 数量；0 表示不使用 Worker（主线程直连）。默认 min(核数, 4) */
  workers?: number
  /** worker.js 的地址；默认取本模块同目录 */
  workerUrl?: string | URL
  /** wasm 所在目录；默认与胶水代码同目录 */
  wasmBase?: string
  /** 启用 SVG 输入（需要 vips-resvg.wasm） */
  svg?: boolean
  /** libvips 内部线程数 */
  threads?: number
  /** 自定义 wasm 定位函数（仅直连模式生效） */
  locateFile?: (file: string, scriptDirectory: string) => string
}

export interface ImageEngine {
  /** 'worker' = 多线程池；'direct' = 主线程直连 */
  readonly mode: 'worker' | 'direct'
  /** Worker 池大小（direct 恒为 1） */
  readonly size: number

  /** 核心：按 ops 顺序处理，再按 output 编码 */
  process(
    source: ImageSource,
    ops?: Operation[],
    output?: OutputOptions,
    control?: ProcessControl,
  ): Promise<ProcessResult>
  /** 只缩放 */
  resize(
    source: ImageSource,
    options?: Omit<ResizeOp, 'op'> & { output?: OutputOptions; control?: ProcessControl },
  ): Promise<ProcessResult>
  /** 只裁剪 */
  crop(
    source: ImageSource,
    options?: Omit<CropOp, 'op'> & { output?: OutputOptions; control?: ProcessControl },
  ): Promise<ProcessResult>
  /** 只转格式 */
  convert(source: ImageSource, output?: OutputOptions, control?: ProcessControl): Promise<ProcessResult>
  /** 读元信息（不解码像素） */
  metadata(source: ImageSource): Promise<ImageMetadata>
  /** 释放 Worker / WASM 资源 */
  destroy(): void
}

/** 创建引擎 */
export function createImageEngine(options?: EngineOptions): Promise<ImageEngine>

/** 环境是否支持 WebAssembly */
export function isSupported(): boolean

/** 可产出的格式清单 */
export const OUTPUT_FORMATS: string[]

/** 格式 → MIME */
export const MIME_BY_FORMAT: Record<string, string>

/** 引擎错误，带稳定 code */
export class EngineError extends Error {
  code: string
}
