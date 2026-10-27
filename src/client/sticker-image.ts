import { MAX_STICKER_DIMENSION, analyzeAlpha, checkAlpha } from "@/domain/sticker";
import { imageFromUrl } from "./assets";

export type StickerErrorCode = "file_type" | "file_size" | "image_size" | "image_decode" | "sticker_no_alpha" | "sticker_empty";
export class StickerError extends Error {
  constructor(readonly code: StickerErrorCode) { super(code); }
}
const UPLOAD_LIMIT = 10 * 1024 * 1024;
const PIXEL_LIMIT = 16_777_216;

/** 把图片解码成可以画到 Canvas 上的元素。解码失败统一报 image_decode。 */
export async function decodeSticker(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try { return await imageFromUrl(url); }
  catch { throw new StickerError("image_decode"); }
  finally { URL.revokeObjectURL(url); } // 解码完成后图片元素不再依赖这个地址
}

/**
 * 读取用户上传的贴纸并校验：
 * - 只接受 PNG 和 WebP（JPEG 没有透明通道，直接说明原因）；≤10 MB；≤1600 万像素，每边 ≤16384；
 * - 读出真实的 Alpha 通道，检查透明像素和可见内容的占比（规则见 domain/sticker.ts）。
 * 不合格就抛 StickerError，贴纸不会进入工程。
 */
export async function loadSticker(blob: Blob): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  if (blob.type === "image/jpeg") throw new StickerError("sticker_no_alpha");
  if (!["image/png", "image/webp"].includes(blob.type)) throw new StickerError("file_type");
  if (blob.size > UPLOAD_LIMIT) throw new StickerError("file_size");
  const image = await decodeSticker(blob), width = image.naturalWidth, height = image.naturalHeight;
  if (width < 1 || height < 1 || width * height > PIXEL_LIMIT || width > MAX_STICKER_DIMENSION || height > MAX_STICKER_DIMENSION) throw new StickerError("image_size");
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new StickerError("image_decode");
  try {
    context.drawImage(image, 0, 0);
    const verdict = checkAlpha(analyzeAlpha(context.getImageData(0, 0, width, height).data, width, height));
    if (verdict !== "ok") throw new StickerError(verdict);
  } finally { canvas.width = canvas.height = 0; } // 立即释放这块可能很大的画布
  return { image, width, height };
}

/** 一张自带的示例贴纸（红色星形徽章，背景透明，边缘抗锯齿），方便没有素材时试用。 */
export async function makeSampleSticker(): Promise<File> {
  const size = 512, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new StickerError("image_decode");
  context.translate(size / 2, size / 2);
  context.beginPath();
  for (let i = 0; i < 24; i++) {
    const radius = i % 2 === 0 ? 240 : 205, angle = (i * Math.PI) / 12;
    if (i === 0) context.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius); else context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  context.closePath();
  context.fillStyle = "#E11D48"; context.fill();
  context.lineWidth = 8; context.strokeStyle = "#FFFFFF";
  context.beginPath(); context.arc(0, 0, 168, 0, Math.PI * 2); context.stroke();
  context.fillStyle = "#FFFFFF"; context.font = '800 116px Geist, system-ui, sans-serif'; context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText("NEW", 0, 8);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  if (!blob) throw new StickerError("image_decode");
  return new File([blob], "sample-sticker.png", { type: "image/png" });
}
