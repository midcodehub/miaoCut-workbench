/**
 * 精确换色的纯函数部分：颜色空间转换、明度映射、遮罩羽化、逐像素换色、涂抹笔画的撤销/重做。
 * 这里没有任何浏览器 API（Canvas、IndexedDB 都在 src/client 里），所以可以在 Node 里直接测试。
 *
 * 算法（对应设计文档 §5.2）：在 CIE Lab 空间里把商品区域的“色相和彩度”换成目标色，
 * 同时按目标色的明度整体平移，但**保留每个像素相对于平均明度的起伏**，所以褶皱、纹理、明暗关系都还在。
 *
 * 整个映射只依赖像素的明度 L，所以不必对每个像素做完整的色彩转换：
 * 先对一个固定的目标色预先算出一张 “源明度 → 输出 RGB” 的查找表（见 buildTable），
 * 逐像素时只需要算一次明度、查一次表。
 */

export const MAX_COLORS = 8;
/** 查找表的明度分辨率：0～100 切成 4096 份，每份 0.0244。比 8 位 RGB 能分辨的明度差小一个数量级，量化误差看不见。 */
export const TABLE_SIZE = 4096;
/** 明度平移超过这个值（Lab 的 L 单位，满量程 100）就提示用户“明暗跨度大，纹理会变淡”。 */
export const WIDE_SHIFT = 35;

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

// ───────────────────────── 颜色基础 ─────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

export function parseHex(hex: string): Rgb | null {
  if (!isHex(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
export const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** 清洗颜色列表：只保留合法的 #RRGGBB，统一大写，去重，最多 8 个。顺序按首次出现。 */
export function normalizeColors(colors: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const color of colors) {
    if (!isHex(color)) continue;
    seen.add(color.toUpperCase());
    if (seen.size === MAX_COLORS) break;
  }
  return [...seen];
}

// sRGB（0～255）→ 线性光（0～1）。256 项的查找表，避免逐像素调用 Math.pow。
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const encode = (linear: number) => {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

// CIE 常数（D65 白点，sRGB）。
const EPSILON = 216 / 24389, KAPPA = 24389 / 27;
const WHITE: Rgb = [0.95047, 1, 1.08883];
const labF = (t: number) => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const labFInverse = (t: number) => { const cube = t * t * t; return cube > EPSILON ? cube : (116 * t - 16) / KAPPA; };

/** 线性光 Y（相对亮度）→ Lab 的 L。 */
export const lightnessOfLuminance = (y: number) => (y > EPSILON ? 116 * Math.cbrt(y) - 16 : KAPPA * y);

export function rgbToLab([r, g, b]: Rgb): Lab {
  const lr = LINEAR[r], lg = LINEAR[g], lb = LINEAR[b];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE[0];
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / WHITE[2];
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab → 线性 sRGB，不裁剪：超出 [0,1] 就是超出了 sRGB 色域。 */
export function labToLinear(L: number, a: number, b: number): Rgb {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = labFInverse(fx) * WHITE[0], z = labFInverse(fz) * WHITE[2];
  const y = L > KAPPA * EPSILON ? fy * fy * fy : L / KAPPA;
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
}

/** 一个 Lab 颜色是否落在 sRGB 色域里（留一点浮点误差）。 */
const inGamut = ([r, g, b]: Rgb) => r >= -1e-4 && r <= 1.0001 && g >= -1e-4 && g <= 1.0001 && b >= -1e-4 && b <= 1.0001;

/**
 * 色域映射：保持明度和色相不变，只把彩度往中性灰方向压到刚好放得进 sRGB。
 * 二分 12 次，精度约 1/4096，远小于 8 位颜色的一级。
 */
export function gamutMap(L: number, a: number, b: number): Rgb {
  const full = labToLinear(L, a, b);
  if (inGamut(full)) return full;
  let low = 0, high = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    if (inGamut(labToLinear(L, a * mid, b * mid))) low = mid; else high = mid;
  }
  return labToLinear(L, a * low, b * low);
}

// ───────────────────────── 明度映射和查找表 ─────────────────────────

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 把源明度 L 平移：源的平均明度 sourceL 正好变成 targetL，每个像素相对平均值的起伏保留（斜率恒为正，明暗的先后顺序不会颠倒）。
 *   变亮（Δ ≥ 0）：L' = L + Δ·(100−L)/(100−sourceL)   白色(100)不动，暗部随之抬高，不会被裁到 100 以上
 *   变暗（Δ < 0）：L' = L + Δ·L/sourceL                黑色(0)不动，亮部随之压低，不会被裁到 0 以下
 * （Δ = targetL − sourceL。变亮时暗部被抬高、变暗时高光被压低，与真实物体换成更浅/更深的材质时的样子一致。）
 */
export function mapLightness(L: number, sourceL: number, targetL: number): number {
  const pivot = clamp(sourceL, 1, 99), delta = targetL - pivot;
  return delta >= 0 ? L + (delta * (100 - L)) / (100 - pivot) : L + (delta * L) / pivot;
}

/** 彩度系数：比目标色亮的高光逐渐回到中性（越亮越不饱和，像真实物体的高光），不比目标色亮的部分保持满彩度。 */
const chromaGain = (L: number, targetL: number) => (L <= targetL ? 1 : targetL >= 100 ? 0 : (100 - L) / (100 - targetL));

/** 目标色平均明度和源平均明度差得多远。 */
export const lightnessShift = (sourceL: number, targetHex: string): number => {
  const target = parseHex(targetHex);
  return target ? Math.abs(rgbToLab(target)[0] - sourceL) : 0;
};
export const isWideShift = (sourceL: number, targetHex: string) => lightnessShift(sourceL, targetHex) > WIDE_SHIFT;

/**
 * 预先算好 “源明度 → 输出 RGB” 的查找表：TABLE_SIZE 项，每项 3 个字节。
 * 第 i 项对应源明度 L = i·100/(TABLE_SIZE−1)。
 */
export function buildTable(targetHex: string, sourceL: number): Uint8Array {
  const target = parseHex(targetHex);
  if (!target) throw new Error("invalid_color");
  const [targetL, targetA, targetB] = rgbToLab(target);
  const table = new Uint8Array(TABLE_SIZE * 3);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const L = clamp(mapLightness((i * 100) / (TABLE_SIZE - 1), sourceL, targetL), 0, 100);
    const gain = chromaGain(L, targetL);
    const [r, g, b] = gamutMap(L, targetA * gain, targetB * gain);
    table[i * 3] = encode(r); table[i * 3 + 1] = encode(g); table[i * 3 + 2] = encode(b);
  }
  return table;
}

// ───────────────────────── 逐像素换色 ─────────────────────────

const toIndex = (L: number) => { const index = Math.round((L * (TABLE_SIZE - 1)) / 100); return index < 0 ? 0 : index >= TABLE_SIZE ? TABLE_SIZE - 1 : index; };
/** 一个 RGBA 像素的 Lab 明度 L。 */
const pixelLightness = (data: Uint8ClampedArray, offset: number) =>
  lightnessOfLuminance(0.2126729 * LINEAR[data[offset]] + 0.7151522 * LINEAR[data[offset + 1]] + 0.072175 * LINEAR[data[offset + 2]]);

export interface LightnessSum { sum: number; weight: number }
/**
 * 累加遮罩范围内像素的明度（权重 = 遮罩值 × 不透明度），用来求“被涂抹区域的平均明度”。
 * 可以分段调用（start/end 是像素序号），调用方在段与段之间让出主线程，界面不卡。
 */
export function accumulateLightness(data: Uint8ClampedArray, mask: Uint8Array, start: number, end: number, into: LightnessSum): LightnessSum {
  let sum = 0, weight = 0;
  for (let i = start; i < end; i++) {
    const m = mask[i];
    if (m === 0) continue;
    const alpha = data[i * 4 + 3];
    if (alpha === 0) continue;
    const w = m * alpha;
    sum += pixelLightness(data, i * 4) * w; weight += w;
  }
  into.sum += sum; into.weight += weight;
  return into;
}
/** 平均明度；遮罩里没有可见像素时返回 null（也就是“空遮罩”）。 */
export const meanLightness = ({ sum, weight }: LightnessSum): number | null => (weight > 0 ? sum / weight : null);

/**
 * 逐像素换色，写入 [start, end) 这一段。dst 必须已经是 src 的完整拷贝：遮罩值为 0 的像素这里**完全不碰**，
 * 所以遮罩外的字节与原图逐字节相同。
 *   遮罩值 255：像素直接换成查表结果；介于 0 和 255 之间（羽化的边缘）：按比例与原像素混合。
 *   alpha 通道永远不改；alpha 为 0 的像素看不见，也不处理。
 */
export function recolorPixels(src: Uint8ClampedArray, mask: Uint8Array, table: Uint8Array, dst: Uint8ClampedArray, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const m = mask[i];
    if (m === 0) continue;
    const offset = i * 4;
    if (src[offset + 3] === 0) continue;
    const t = toIndex(pixelLightness(src, offset)) * 3;
    if (m === 255) {
      dst[offset] = table[t]; dst[offset + 1] = table[t + 1]; dst[offset + 2] = table[t + 2];
    } else {
      const w = m / 255;
      // dst 是 Uint8ClampedArray，赋值时自动四舍五入到整数。
      dst[offset] = src[offset] + (table[t] - src[offset]) * w;
      dst[offset + 1] = src[offset + 1] + (table[t + 1] - src[offset + 1]) * w;
      dst[offset + 2] = src[offset + 2] + (table[t + 2] - src[offset + 2]) * w;
    }
  }
}

// ───────────────────────── 遮罩 ─────────────────────────

/** 水平方向的方框模糊（窗口 2r+1，窗口外按 0 算）：每一行用滑动窗口求和，复杂度与半径无关。 */
function blurRows(src: Uint8Array, dst: Uint8Array, width: number, height: number, radius: number) {
  const size = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let sum = 0;
    // 第 0 个像素的窗口覆盖 [-r, r]，窗口外按 0 算，所以只累加 [0, r]。
    for (let x = 0; x <= radius && x < width; x++) sum += src[base + x];
    for (let x = 0; x < width; x++) {
      dst[base + x] = Math.round(sum / size);
      const leaving = x - radius, entering = x + radius + 1;
      if (leaving >= 0) sum -= src[base + leaving];
      if (entering < width) sum += src[base + entering];
    }
  }
}

/**
 * 竖直方向的方框模糊。不按列扫描（相邻两次读取隔一整行，缓存命中很差，大图会慢很多），
 * 而是维护“每一列在当前窗口里的和”，逐行向下滑动，内存访问始终是顺序的。
 */
function blurColumns(src: Uint8Array, dst: Uint8Array, width: number, height: number, radius: number) {
  const size = 2 * radius + 1, sums = new Int32Array(width);
  for (let y = 0; y <= radius && y < height; y++) for (let x = 0; x < width; x++) sums[x] += src[y * width + x];
  for (let y = 0; y < height; y++) {
    const base = y * width, leaving = y - radius, entering = y + radius + 1;
    for (let x = 0; x < width; x++) dst[base + x] = Math.round(sums[x] / size);
    if (leaving >= 0) for (let x = 0; x < width; x++) sums[x] -= src[leaving * width + x];
    if (entering < height) for (let x = 0; x < width; x++) sums[x] += src[entering * width + x];
  }
}

/**
 * 边缘柔化的分步版本：每完成一次“水平 + 竖直”方框模糊就 yield 一次，三次之后返回结果。
 * 大图上一次完整的柔化要几百毫秒，调用方可以在每次 yield 时让出主线程，界面不会被一次卡住几百毫秒。
 * 不修改传入的遮罩。
 */
export function* featherSteps(mask: Uint8Array, width: number, height: number, radius: number): Generator<void, Uint8Array> {
  const r = Math.round(radius);
  if (r <= 0) return mask;
  const middle = new Uint8Array(mask.length), buffers = [new Uint8Array(mask.length), new Uint8Array(mask.length)];
  let current = mask;
  for (let pass = 0; pass < 3; pass++) {
    const out = buffers[pass % 2];
    blurRows(current, middle, width, height, r);
    blurColumns(middle, out, width, height, r);
    current = out;
    yield;
  }
  return current;
}

/**
 * 边缘柔化：连续做三次方框模糊，近似高斯模糊，耗时与半径无关。radius 是每次方框的半径（像素），0 表示不柔化。
 * 模糊会让遮罩向外多扩一点、向内变淡；遮罩值仍为 0 的地方才是“保证不变”的区域。返回新数组，不修改传入的遮罩。
 */
export function featherMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const steps = featherSteps(mask, width, height, radius);
  for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

/** 遮罩里“有改动”的像素占比（遮罩值 ≥ 128），用来显示“涂抹面积”；0 表示空遮罩。 */
export function coverageOf(mask: Uint8Array): number {
  let covered = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= 128) covered++;
  return mask.length === 0 ? 0 : covered / mask.length;
}

/** 把遮罩按面积平均缩小到 outWidth × outHeight，给色块缩略图使用。 */
export function downscaleMask(mask: Uint8Array, width: number, height: number, outWidth: number, outHeight: number): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const y0 = Math.floor((y * height) / outHeight), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const x0 = Math.floor((x * width) / outWidth), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += mask[yy * width + xx];
      out[y * outWidth + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

// ───────────────────────── 涂抹笔画与撤销/重做 ─────────────────────────

/**
 * 一笔涂抹。坐标和半径都归一化，与图片的实际像素无关：
 * 点按图片宽、高归一化到 0～1，交替存放 [x0,y0,x1,y1,…]；半径按图片长边归一化。
 * 这样同一份笔画可以在预览缩略图和全分辨率导出中得到一致的范围，也能原样存进浏览器。
 */
export interface Stroke { erase: boolean; radius: number; points: number[] }

export const MAX_STROKES = 300;
/** 所有笔画的点数上限。超过后新的一笔不再被接受，避免长时间涂抹把存储和重放拖慢。 */
export const MAX_POINTS = 60_000;
export const MIN_RADIUS = 0.001, MAX_RADIUS = 0.2;

/** 画笔直径（界面滑块的数值，按长边 1024 像素的图来算）和边缘柔化的取值范围。 */
export const BRUSH = { min: 4, max: 160, initial: 48 } as const;
export const FEATHER = { max: 12, initial: 2 } as const;
/** 滑块里的画笔直径 → 笔画半径（按图片长边归一化）。 */
export const brushRadius = (size: number) => clamp(size, BRUSH.min, BRUSH.max) / 2048;
/** 滑块里的柔化值 → 方框模糊半径（像素）。柔化值按 1024 像素的图来算，图越大半径按比例放大，所以不同尺寸的图边缘观感一致。 */
export const featherRadius = (feather: number, longSide: number) => Math.round((clamp(feather, 0, FEATHER.max) * longSide) / 2048);

/** 第一次打开时放几个颜色，直接就能看到换色效果；之后都是用户自己的选择。 */
export const STARTER_COLORS = ["#C62828", "#1565C0", "#2E7D32", "#F9A825"];
/** 快速添加的常用色。 */
export const PRESET_COLORS = ["#C62828", "#E91E63", "#F57C00", "#F9A825", "#2E7D32", "#00838F", "#1565C0", "#6A1B9A", "#5D4037", "#212121", "#9E9E9E", "#F5F5F5"];

export interface EditState { strokes: Stroke[]; undone: Stroke[] }
export const emptyEdit = (): EditState => ({ strokes: [], undone: [] });

const pointCount = (strokes: readonly Stroke[]) => strokes.reduce((total, stroke) => total + stroke.points.length / 2, 0);

export function validStroke(value: unknown): value is Stroke {
  if (typeof value !== "object" || value === null) return false;
  const { erase, radius, points } = value as Partial<Stroke>;
  return typeof erase === "boolean" && typeof radius === "number" && radius >= MIN_RADIUS && radius <= MAX_RADIUS
    && Array.isArray(points) && points.length >= 2 && points.length % 2 === 0 && points.length <= MAX_POINTS * 2
    && points.every(p => typeof p === "number" && p >= 0 && p <= 1);
}

/** 记下新的一笔。已经达到上限时原样返回同一个对象（调用方据此判断“没记下来”）。新的一笔会清空“重做”栈。 */
export function addStroke(edit: EditState, stroke: Stroke): EditState {
  if (!validStroke(stroke) || edit.strokes.length >= MAX_STROKES || pointCount(edit.strokes) + stroke.points.length / 2 > MAX_POINTS) return edit;
  return { strokes: [...edit.strokes, stroke], undone: [] };
}
export function undo(edit: EditState): EditState {
  const last = edit.strokes[edit.strokes.length - 1];
  return last ? { strokes: edit.strokes.slice(0, -1), undone: [...edit.undone, last] } : edit;
}
export function redo(edit: EditState): EditState {
  const next = edit.undone[edit.undone.length - 1];
  return next ? { strokes: [...edit.strokes, next], undone: edit.undone.slice(0, -1) } : edit;
}
/** 清除全部涂抹。清除本身可以撤销：笔画按相反顺序放进“重做”栈，连按重做会按原来的顺序恢复。 */
export function clearStrokes(edit: EditState): EditState {
  return edit.strokes.length === 0 ? edit : { strokes: [], undone: [...edit.undone, ...[...edit.strokes].reverse()] };
}
/** 工程里存下来的笔画可能被篡改或损坏：逐笔校验，非法的整笔丢掉。 */
export function sanitizeStrokes(value: unknown): Stroke[] {
  if (!Array.isArray(value)) return [];
  let edit = emptyEdit();
  for (const stroke of value) edit = addStroke(edit, stroke as Stroke);
  return edit.strokes;
}
