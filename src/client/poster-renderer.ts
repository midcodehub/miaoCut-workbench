import { FONTS, POSTER_SIZE, fitText, type FitResult, type PosterDocument, type TextLayer } from "@/domain/poster";

export const fontSpec = (layer: Pick<TextLayer, "weight" | "fontId">, size: number) =>
  `${layer.weight} ${size}px ${FONTS[layer.fontId].stack}`;

/**
 * Geist 是按需加载的 @font-face，Canvas 绘制本身不会触发加载。
 * 不先等它加载好，第一次绘制会悄悄用回退字体，导出的字形就和之后不一样。
 */
export async function ensureFonts(doc: PosterDocument): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const wanted = new Map<string, string>();
  for (const layer of doc.layers) {
    const font = fontSpec(layer, 32);
    wanted.set(font, (wanted.get(font) ?? "") + layer.text);
  }
  await Promise.all([...wanted].map(([font, text]) => document.fonts.load(font, text).catch(() => [])));
}

/** 图片按“填满”方式居中裁切到正方形画布。 */
function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number) {
  const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
}

/**
 * 画出整张海报：背景 → 文字层（数组顺序即叠放顺序）。返回每个文字层的适配结果，界面据此提示“文字超出文本框”。
 * 文字在文本框内水平按所选对齐、垂直居中；字号由 fitText 取“放得下的最大值”。
 */
export function drawPoster(ctx: CanvasRenderingContext2D, doc: PosterDocument, image?: HTMLImageElement): Map<string, FitResult> {
  const size = POSTER_SIZE, fits = new Map<string, FitResult>();
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  if (doc.background.kind === "solid") { ctx.fillStyle = doc.background.color; ctx.fillRect(0, 0, size, size); }
  else {
    // 图片还没解码好时先铺中性灰，避免闪出透明棋盘。
    ctx.fillStyle = "#E5E7EB"; ctx.fillRect(0, 0, size, size);
    if (image) drawCover(ctx, image, size);
  }
  for (const layer of doc.layers) {
    const x1 = layer.box[0] * size, y1 = layer.box[1] * size, width = (layer.box[2] - layer.box[0]) * size, height = (layer.box[3] - layer.box[1]) * size;
    const fit = fitText(layer.text, width, height, (text, fontSize) => { ctx.font = fontSpec(layer, fontSize); return ctx.measureText(text).width; });
    fits.set(layer.id, fit);
    ctx.font = fontSpec(layer, fit.fontSize);
    ctx.fillStyle = layer.color; ctx.textAlign = layer.align; ctx.textBaseline = "middle";
    const x = layer.align === "left" ? x1 : layer.align === "center" ? x1 + width / 2 : x1 + width;
    const top = y1 + (height - fit.lines.length * fit.lineHeight) / 2;
    fit.lines.forEach((line, index) => ctx.fillText(line, x, top + (index + 0.5) * fit.lineHeight));
  }
  ctx.restore();
  return fits;
}

/**
 * 导出 1024×1024 PNG，直接从用户正在看的这块预览画布导出。
 *
 * 不能另建一块离屏画布来导出：同样的文字画在“挂在页面上的画布”和“游离的画布”上，Chrome 给出的像素并不相同
 * （实测同一段文字有约 1.6 万个像素不同，笔画边缘和约 1px 的基线位置都会变），
 * 导出的图就会和屏幕上看到的不一样。所以这里在预览画布上用同一个 drawPoster 重画一次（内容不变，不会闪），
 * 再 toBlob：导出的就是屏幕上的像素。
 */
export async function exportPoster(doc: PosterDocument, image: HTMLImageElement | undefined, canvas: HTMLCanvasElement): Promise<Blob> {
  await ensureFonts(doc);
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width !== POSTER_SIZE || canvas.height !== POSTER_SIZE) throw new Error("canvas_unavailable");
  drawPoster(ctx, doc, image);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("export_failed"))), "image/png"));
}
