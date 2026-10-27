/**
 * 贴纸的纯函数部分：透明度校验和几何（位置、大小、旋转）。没有任何浏览器 API，可以在 Node 里直接测试。
 *
 * 产品规则见私有仓库 docs/product-workbench-modules-design.md §7.3、§7.4：
 * - 贴纸必须是带真实 Alpha 的图片：检查透明像素比例和可见内容，不合格的不放上画布。
 * - 位置用归一化坐标 [x1,y1,x2,y2]（0～1，与文本框相同），再加一个绕外框中心的旋转角度。
 */
import type { Box } from "./poster";

/** 贴纸原图每个方向的像素上限。总像素数另有 1600 万的上限（由读取图片的一侧检查）。 */
export const MAX_STICKER_DIMENSION = 16384;
/** 贴纸长边至少占画布的 5%，再小就无法选中。 */
export const MIN_STICKER_SIZE = 0.05;
/** 新贴纸的长边占画布的 40%。 */
export const DEFAULT_STICKER_SIZE = 0.4;

/** alpha ≤ 8（约 3%）的像素算“透明”，alpha ≥ 128 的像素算“可见”。 */
export const TRANSPARENT_ALPHA = 8;
export const VISIBLE_ALPHA = 128;
/**
 * 至少 0.2% 的像素是透明的，才认为图片有真实的透明通道。
 * 圆角矩形（圆角半径为边长的 10%）的四个角约占 0.86%，高于这个下限；完全不透明的图（包括把棋盘格画进 RGB 冒充透明的图）为 0。
 */
export const MIN_TRANSPARENT_RATIO = 0.002;
/** 至少 0.5% 的像素可见，否则认为图片是空的。 */
export const MIN_VISIBLE_RATIO = 0.005;

export interface AlphaStats { transparent: number; visible: number }
/** 统计 RGBA 像素里透明和可见像素的占比（0～1）。 */
export function analyzeAlpha(data: Uint8ClampedArray, width: number, height: number): AlphaStats {
  const total = width * height;
  if (total <= 0 || data.length < total * 4) return { transparent: 0, visible: 0 };
  let transparent = 0, visible = 0;
  for (let i = 0; i < total; i++) {
    const alpha = data[i * 4 + 3];
    if (alpha <= TRANSPARENT_ALPHA) transparent++;
    if (alpha >= VISIBLE_ALPHA) visible++;
  }
  return { transparent: transparent / total, visible: visible / total };
}

/** sticker_empty：几乎没有可见内容；sticker_no_alpha：没有（足够的）透明区域，不是真正带透明背景的贴纸。 */
export type StickerCheck = "ok" | "sticker_empty" | "sticker_no_alpha";
export function checkAlpha({ transparent, visible }: AlphaStats): StickerCheck {
  if (visible < MIN_VISIBLE_RATIO) return "sticker_empty";
  if (transparent < MIN_TRANSPARENT_RATIO) return "sticker_no_alpha";
  return "ok";
}

// ---------------------------------------------------------------------------
// 几何：贴纸的外框始终在画布内，宽高比与图片的像素宽高比一致（画布是正方形，所以归一化后的比例也一致）。
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** 宽高比为 aspect（像素宽 / 像素高）时，归一化宽度的合法范围：长边在 [MIN_STICKER_SIZE, 1] 之间。 */
export function widthRange(aspect: number): [number, number] {
  return [aspect >= 1 ? MIN_STICKER_SIZE : MIN_STICKER_SIZE * aspect, Math.min(1, aspect)];
}
/** 由中心点和宽度得到外框：宽度先收敛到合法范围，再把外框推回画布内。 */
export function stickerBox(cx: number, cy: number, width: number, aspect: number): Box {
  const [lo, hi] = widthRange(aspect), w = clamp(finite(width, DEFAULT_STICKER_SIZE), lo, hi), h = w / aspect;
  const x1 = clamp(finite(cx, 0.5) - w / 2, 0, 1 - w), y1 = clamp(finite(cy, 0.5) - h / 2, 0, 1 - h);
  return [x1, y1, x1 + w, y1 + h];
}
export const boxCenter = (box: Box): [number, number] => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

/** 新贴纸的外框：长边占 40%，居中，已有的贴纸越多偏移越多（最多错开 5 个位置），避免完全叠在一起。 */
export function initialStickerBox(width: number, height: number, existing: number): Box {
  const aspect = width / height, offset = ((existing % 5) - 2) * 0.04;
  return stickerBox(0.5 + offset, 0.5 + offset, aspect >= 1 ? DEFAULT_STICKER_SIZE : DEFAULT_STICKER_SIZE * aspect, aspect);
}

/** 旋转角度收敛到 (-180, 180]，保留一位小数。 */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  let r = ((degrees % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.round(r * 10) / 10 || 0; // `|| 0` 把 -0 变成 0
}
