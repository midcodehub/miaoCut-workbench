import { downscaleMask, type Stroke } from "@/domain/recolor";
import { AssetError, imageFromUrl } from "./assets";

/** 色块缩略图的长边像素数。 */
export const THUMB_SIZE = 160;
/** 涂抹层（红色）画布的长边上限：只用来显示，不参与计算。 */
export const OVERLAY_SIZE = 1024;
/** 每一段处理的像素数。一段在普通电脑上大约 10～20 ms，段与段之间让出主线程，界面不会卡住。 */
export const SLICE = 1 << 18;
const UPLOAD_LIMIT = 10 * 1024 * 1024;
const PIXEL_LIMIT = 16_777_216;

/** 一张已经解码好的底图：完整分辨率的像素，加一张缩略图大小的副本（给色块预览用）。 */
export interface LoadedSource { blob: Blob; name: string; width: number; height: number; original: ImageData; proxy: ImageData }

/** 让出主线程，等浏览器处理完输入和绘制再继续。 */
export const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** 把 [0,total) 切成多段依次执行，段间让出主线程。中途被取消返回 false。 */
export async function inSlices(cancelled: () => boolean, total: number, work: (start: number, end: number) => void): Promise<boolean> {
  for (let start = 0; start < total; start += SLICE) {
    if (cancelled()) return false;
    work(start, Math.min(total, start + SLICE));
    await yieldToBrowser();
  }
  return !cancelled();
}

/**
 * 解码底图：校验类型、字节数（上传 10 MB，结果页带来的图放宽到 limit）和像素数（≤ 1600 万），
 * 读出完整分辨率的像素。canvas 读出的是 sRGB，带色彩配置文件的图会先被浏览器转换。
 */
export async function loadSource(blob: Blob, name: string, limit = UPLOAD_LIMIT): Promise<LoadedSource> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new AssetError("file_type");
  if (blob.size > limit) throw new AssetError("file_size");
  const url = URL.createObjectURL(blob);
  try {
    const image = await imageFromUrl(url), width = image.naturalWidth, height = image.naturalHeight;
    if (width < 1 || height < 1 || width * height > PIXEL_LIMIT) throw new AssetError("image_size");
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new AssetError("image_decode");
    context.drawImage(image, 0, 0);
    const original = context.getImageData(0, 0, width, height);
    const scale = Math.min(1, THUMB_SIZE / Math.max(width, height)), pw = Math.max(1, Math.round(width * scale)), ph = Math.max(1, Math.round(height * scale));
    const small = document.createElement("canvas");
    small.width = pw; small.height = ph;
    const smallContext = small.getContext("2d", { willReadFrequently: true });
    if (!smallContext) throw new AssetError("image_decode");
    smallContext.imageSmoothingQuality = "high";
    smallContext.drawImage(image, 0, 0, pw, ph);
    return { blob, name, width, height, original, proxy: smallContext.getImageData(0, 0, pw, ph) };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * 在 2D 画布上画一笔。mask 模式：画笔用白色，橡皮用黑色（后画的盖住先画的）；
 * overlay 模式：画笔画不透明红色，橡皮用 destination-out 擦成透明。整层红色由 CSS 统一设置半透明，笔画重叠处不会叠深。
 * 坐标和半径都是归一化的，按画布大小换算，所以预览层和全分辨率遮罩得到同样的形状。
 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, mode: "mask" | "overlay") {
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.lineWidth = stroke.radius * 2 * Math.max(width, height);
  if (mode === "mask") ctx.strokeStyle = stroke.erase ? "#000" : "#fff";
  else if (stroke.erase) { ctx.globalCompositeOperation = "destination-out"; ctx.strokeStyle = "#000"; }
  else ctx.strokeStyle = "#ef4444";
  ctx.beginPath();
  ctx.moveTo(stroke.points[0] * width, stroke.points[1] * height);
  // 只有一个点时补一个同位置的线段，圆头线帽会画出一个圆点。
  if (stroke.points.length === 2) ctx.lineTo(stroke.points[0] * width, stroke.points[1] * height);
  for (let i = 2; i < stroke.points.length; i += 2) ctx.lineTo(stroke.points[i] * width, stroke.points[i + 1] * height);
  ctx.stroke();
  ctx.restore();
}

/** 把所有笔画重放到一块全分辨率的画布上，读出红通道作为遮罩（0～255，边缘有抗锯齿的过渡值）。 */
export function renderMask(strokes: readonly Stroke[], width: number, height: number): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas_unavailable");
  context.fillStyle = "#000"; context.fillRect(0, 0, width, height);
  for (const stroke of strokes) drawStroke(context, stroke, width, height, "mask");
  const rgba = context.getImageData(0, 0, width, height).data, mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4];
  canvas.width = canvas.height = 0; // 立即释放这块大画布占用的内存
  return mask;
}

/** 涂抹层画布的尺寸：与底图同比例，长边不超过 OVERLAY_SIZE。 */
export function overlaySize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, OVERLAY_SIZE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 缩略图用的遮罩：从最终（已柔化）的全分辨率遮罩面积平均缩小而来。 */
export const proxyMask = (mask: Uint8Array, source: LoadedSource) =>
  downscaleMask(mask, source.width, source.height, source.proxy.width, source.proxy.height);

/** 把像素写到一块新画布并编码成 PNG。用于下载和交给海报页；画布在编码后立即释放。 */
export function encodePng(pixels: ImageData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width; canvas.height = pixels.height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("canvas_unavailable"));
  context.putImageData(pixels, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    canvas.width = canvas.height = 0;
    if (blob) resolve(blob); else reject(new Error("export_failed"));
  }, "image/png"));
}
