/**
 * 海报精确文字层的领域模型（纯函数，不碰 DOM，方便单测）。
 *
 * 产品规则见私有仓库 docs/product-workbench-modules-design.md §7：
 * - 文字是确定性渲染的：内容逐字一致，位置就是文本框的归一化坐标，修改文字不会触发任何 GPU 任务。
 * - 文本框坐标 [x1,y1,x2,y2] 取值 0～1，与后续 WF5 的 textBox 契约相同。
 * - 一张海报最多 8 个文本框，每个最多 300 字，换行保存为真实的 "\n"。
 * - 首版只有 1:1 画幅（1024×1024）。其他画幅要等各自通过认证后再开放。
 */
import { MAX_STICKER_DIMENSION, boxCenter, initialStickerBox, normalizeRotation, stickerBox, widthRange } from "./sticker";

export const POSTER_SIZE = 1024;
export const MAX_TEXT_LAYERS = 8;
/** 贴纸最多 8 张，与文字框的上限分开计算。 */
export const MAX_STICKERS = 8;
export const MAX_TEXT_LENGTH = 300;
/** 文本框每条边至少占画布的 6%，再小就无法拖动，也放不下一个字。 */
export const MIN_BOX_SIZE = 0.06;
export const LINE_HEIGHT = 1.25;
const COLOR = /^#[0-9a-f]{6}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Box = [number, number, number, number];
export type FontId = "sans" | "serif";
export type TextAlign = "left" | "center" | "right";
export type Weight = 400 | 700;

/**
 * 可选字体。`sans` 的拉丁字母使用随应用打包的 Geist（SIL OFL）；中文等非拉丁字符回退到访客设备上的系统字体，
 * 所以同一份工程在不同电脑上的中文字形可能不同。导出的 PNG 是在访客自己的浏览器里渲染的。
 */
export const FONTS: Record<FontId, { stack: string; label: { zh: string; en: string } }> = {
  sans: {
    stack: 'Geist, system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    label: { zh: "黑体 / Sans", en: "Sans" },
  },
  serif: {
    stack: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", SimSun, Georgia, "Times New Roman", serif',
    label: { zh: "宋体 / Serif", en: "Serif" },
  },
};

export interface TextLayer {
  kind: "text"; id: string; text: string; box: Box;
  fontId: FontId; color: string; align: TextAlign; weight: Weight;
}
/**
 * 贴纸：用户上传的、带真实透明通道的图片（校验见 sticker.ts）。图片像素另存（IndexedDB，键 `sticker:<id>`），
 * 这里只记录名称、像素尺寸（锁定宽高比）、外框和旋转，工程 JSON 因此很小。
 * box 是**未旋转**时的外框，归一化坐标；rotation 是绕外框中心的角度（度），范围 (-180, 180]。
 */
export interface StickerLayer { kind: "sticker"; id: string; name: string; width: number; height: number; box: Box; rotation: number }
/** 图层按叠放顺序存放：数组越靠后越在上面，文字和贴纸可以交错。 */
export type PosterLayer = TextLayer | StickerLayer;
export const isText = (layer: PosterLayer): layer is TextLayer => layer.kind === "text";
export const isSticker = (layer: PosterLayer): layer is StickerLayer => layer.kind === "sticker";

/** 背景图片的像素另存（IndexedDB），这里只记录来源和尺寸，保证工程 JSON 小而可校验。 */
export type PosterBackground =
  | { kind: "solid"; color: string }
  | { kind: "image"; source: "upload" | "result"; name: string; width: number; height: number };
export interface PosterDocument {
  documentId: string; revision: number; ratio: "1:1";
  background: PosterBackground; layers: PosterLayer[];
}

export const emptyPoster = (documentId: string): PosterDocument =>
  ({ documentId, revision: 0, ratio: "1:1", background: { kind: "solid", color: "#FFFFFF" }, layers: [] });

// ---------------------------------------------------------------------------
// 文本框几何：所有函数都返回新数组，且结果一定在画布内、不小于最小尺寸。
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** 把任意输入收敛成合法文本框：坐标限制在 0～1，宽高不小于 MIN_BOX_SIZE。 */
export function normalizeBox(box: readonly number[]): Box {
  let x1 = clamp(finite(box[0], 0), 0, 1), y1 = clamp(finite(box[1], 0), 0, 1);
  let x2 = clamp(finite(box[2], 1), 0, 1), y2 = clamp(finite(box[3], 1), 0, 1);
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if (x2 - x1 < MIN_BOX_SIZE) { x2 = Math.min(1, x1 + MIN_BOX_SIZE); x1 = x2 - MIN_BOX_SIZE; }
  if (y2 - y1 < MIN_BOX_SIZE) { y2 = Math.min(1, y1 + MIN_BOX_SIZE); y1 = y2 - MIN_BOX_SIZE; }
  return [x1, y1, x2, y2];
}
/** 平移文本框，保持宽高不变；碰到画布边缘就停住。 */
export function moveBox(box: Box, dx: number, dy: number): Box {
  const w = box[2] - box[0], h = box[3] - box[1];
  const x1 = clamp(box[0] + dx, 0, 1 - w), y1 = clamp(box[1] + dy, 0, 1 - h);
  return [x1, y1, x1 + w, y1 + h];
}
/** 拖动右下角：左上角固定，右下角移到 (x2,y2)，不小于最小尺寸、不超出画布。 */
export function resizeBox(box: Box, x2: number, y2: number): Box {
  return normalizeBox([box[0], box[1], Math.max(x2, box[0] + MIN_BOX_SIZE), Math.max(y2, box[1] + MIN_BOX_SIZE)]);
}

// ---------------------------------------------------------------------------
// 文档操作：每次真实修改 revision 加一；无法执行（超上限、找不到、没有变化）时原样返回同一个对象。
// ---------------------------------------------------------------------------
/** 统一换行符并截断到上限。 */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").slice(0, MAX_TEXT_LENGTH);
}
const bump = (doc: PosterDocument, layers: PosterLayer[]): PosterDocument => ({ ...doc, revision: doc.revision + 1, layers });

/** 按序号错开的默认位置，保证 8 个都落在画布内。 */
export function defaultBox(index: number): Box {
  const y1 = Math.min(0.08 + index * 0.1, 0.82);
  return [0.08, y1, 0.92, y1 + 0.14];
}
/**
 * 新文本框优先放在已有文字框的下方，不压在已有文字上；下方放不下时退回 defaultBox。
 * 退回的位置可能与已有的框重叠，但一定在画布内，用户可以拖开。
 */
export function nextBox(layers: readonly TextLayer[]): Box {
  const bottom = layers.reduce((max, layer) => Math.max(max, layer.box[3]), 0), y1 = bottom + 0.02;
  return layers.length > 0 && y1 + 0.14 <= 0.98 ? [0.08, y1, 0.92, y1 + 0.14] : defaultBox(layers.length);
}
export function addText(doc: PosterDocument, id: string, text: string, overrides: Partial<Omit<TextLayer, "kind" | "id">> = {}): PosterDocument {
  const texts = doc.layers.filter(isText);
  if (texts.length >= MAX_TEXT_LAYERS || doc.layers.some(layer => layer.id === id)) return doc;
  const layer: TextLayer = { kind: "text", id, text: cleanText(text), box: nextBox(texts),
    fontId: "sans", color: "#111827", align: "left", weight: 700 };
  return bump(doc, [...doc.layers, patchLayer(layer, overrides)]);
}
function patchLayer(layer: TextLayer, patch: Partial<Omit<TextLayer, "kind" | "id">>): TextLayer {
  const next = { ...layer };
  if (patch.text !== undefined) next.text = cleanText(patch.text);
  if (patch.box !== undefined) next.box = normalizeBox(patch.box);
  if (patch.fontId !== undefined && patch.fontId in FONTS) next.fontId = patch.fontId;
  if (patch.color !== undefined && COLOR.test(patch.color)) next.color = patch.color.toUpperCase();
  if (patch.align !== undefined && ["left", "center", "right"].includes(patch.align)) next.align = patch.align;
  if (patch.weight === 400 || patch.weight === 700) next.weight = patch.weight;
  return next;
}
const same = (a: TextLayer, b: TextLayer) => a.text === b.text && a.fontId === b.fontId && a.color === b.color &&
  a.align === b.align && a.weight === b.weight && a.box.every((v, i) => v === b.box[i]);
export function updateLayer(doc: PosterDocument, id: string, patch: Partial<Omit<TextLayer, "kind" | "id">>): PosterDocument {
  const index = doc.layers.findIndex(layer => layer.id === id);
  const current = doc.layers[index];
  if (!current || !isText(current)) return doc; // 贴纸用 updateSticker
  const next = patchLayer(current, patch);
  if (same(next, current)) return doc;
  return bump(doc, doc.layers.map((layer, i) => (i === index ? next : layer)));
}
/** 添加贴纸。超过 8 张、id 重复、尺寸不合法时原样返回同一个对象。 */
export function addSticker(doc: PosterDocument, id: string, info: { name: string; width: number; height: number }): PosterDocument {
  const count = doc.layers.filter(isSticker).length, { width, height } = info;
  if (count >= MAX_STICKERS || doc.layers.some(layer => layer.id === id) || !validDimensions(width, height)) return doc;
  const layer: StickerLayer = { kind: "sticker", id, name: info.name.slice(0, 255), width, height, box: initialStickerBox(width, height, count), rotation: 0 };
  return bump(doc, [...doc.layers, layer]);
}
/**
 * 修改贴纸的位置、大小或旋转。cx/cy 是外框中心，width 是外框宽度（都归一化）；高度由图片的宽高比决定，
 * 所以怎么拖都不会变形。结果一定在画布内、大小在合法范围内。没有变化时原样返回同一个对象。
 */
export function updateSticker(doc: PosterDocument, id: string, patch: { cx?: number; cy?: number; width?: number; rotation?: number }): PosterDocument {
  const index = doc.layers.findIndex(layer => layer.id === id), current = doc.layers[index];
  if (!current || !isSticker(current)) return doc;
  const placed = patch.cx !== undefined || patch.cy !== undefined || patch.width !== undefined;
  let box = current.box;
  if (placed) {
    const [cx, cy] = boxCenter(current.box);
    box = stickerBox(patch.cx ?? cx, patch.cy ?? cy, patch.width ?? current.box[2] - current.box[0], current.width / current.height);
  }
  const rotation = patch.rotation !== undefined ? normalizeRotation(patch.rotation) : current.rotation;
  if (rotation === current.rotation && box.every((v, i) => Math.abs(v - current.box[i]) < 1e-9)) return doc;
  return bump(doc, doc.layers.map((layer, i) => (i === index ? { ...current, box, rotation } : layer)));
}
export function removeLayer(doc: PosterDocument, id: string): PosterDocument {
  return doc.layers.some(layer => layer.id === id) ? bump(doc, doc.layers.filter(layer => layer.id !== id)) : doc;
}
/** 调整叠放顺序：数组越靠后越在上面。"up" 表示往上层移一格。 */
export function moveLayer(doc: PosterDocument, id: string, direction: "up" | "down"): PosterDocument {
  const from = doc.layers.findIndex(layer => layer.id === id), to = from + (direction === "up" ? 1 : -1);
  if (from < 0 || to < 0 || to >= doc.layers.length) return doc;
  const layers = [...doc.layers];
  [layers[from], layers[to]] = [layers[to], layers[from]];
  return bump(doc, layers);
}
export function setBackground(doc: PosterDocument, background: PosterBackground): PosterDocument {
  if (background.kind === "solid" && !COLOR.test(background.color)) return doc;
  return { ...doc, revision: doc.revision + 1, background };
}

// ---------------------------------------------------------------------------
// 自动适配字号：文本框就是文字的版面，字号取“放得下的最大值”。
// measure 由调用方提供（浏览器里用 canvas.measureText），领域层因此不依赖 DOM，测试里可以用确定的假度量。
// ---------------------------------------------------------------------------
/** 返回 text 在 fontSize 下的像素宽度。 */
export type Measure = (text: string, fontSize: number) => number;
export interface FitResult { fontSize: number; lines: string[]; lineHeight: number; overflow: boolean }

// 中日韩字符每个字都可以断行；其余连续的非空白字符作为一个“词”，尽量不拆开。
const CJK = "\\u2E80-\\u312F\\u3190-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF00-\\uFFEF";
const TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, "gu");

/** 按宽度自动换行，保留用户输入的换行和空行。一个词比整行还宽时按字符硬拆。 */
export function wrapText(text: string, maxWidth: number, fontSize: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") { out.push(""); continue; }
    let line = "";
    const flush = () => { out.push(line.trimEnd()); line = ""; };
    for (const token of paragraph.match(TOKEN) ?? []) {
      if (measure((line + token).trimEnd(), fontSize) <= maxWidth) { line += token; continue; }
      if (line.trim() !== "") flush();
      if (/^\s+$/.test(token)) continue; // 换行处的空格不带到下一行开头
      if (measure(token, fontSize) <= maxWidth) { line = token; continue; }
      for (const ch of token) { // 单个词过长：逐字符硬拆
        if (line !== "" && measure(line + ch, fontSize) > maxWidth) flush();
        line += ch;
      }
    }
    if (line !== "") flush();
  }
  return out;
}
/**
 * 在 width × height（像素）的文本框里找最大字号。放不下最小字号时返回最小字号并标记 overflow，
 * 界面据此提示“文字超出文本框”，而不是悄悄缩得看不清。
 */
export function fitText(text: string, width: number, height: number, measure: Measure,
  limits: { min?: number; max?: number } = {}): FitResult {
  const min = limits.min ?? 8, max = Math.max(min, Math.min(limits.max ?? 400, Math.floor(height)));
  const attempt = (size: number) => {
    const lines = wrapText(text, width, size, measure), lineHeight = size * LINE_HEIGHT;
    const fits = lines.length * lineHeight <= height + 1e-6 && lines.every(line => measure(line, size) <= width + 1e-6);
    return { fontSize: size, lines, lineHeight, fits };
  };
  let lo = min, hi = max, best = attempt(min);
  if (!best.fits) return { fontSize: best.fontSize, lines: best.lines, lineHeight: best.lineHeight, overflow: true };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, tried = attempt(mid);
    if (tried.fits) { best = tried; lo = mid + 1; } else hi = mid - 1;
  }
  return { fontSize: best.fontSize, lines: best.lines, lineHeight: best.lineHeight, overflow: false };
}

// ---------------------------------------------------------------------------
// 本地记录校验：刷新后从 IndexedDB 读回的内容必须先过校验，损坏的记录不会变成画布状态。
// ---------------------------------------------------------------------------
function validBox(box: unknown): box is Box {
  return Array.isArray(box) && box.length === 4 && box.every(v => typeof v === "number" && Number.isFinite(v)) &&
    box.every(v => v >= 0 && v <= 1) && box[2] - box[0] >= MIN_BOX_SIZE - 1e-9 && box[3] - box[1] >= MIN_BOX_SIZE - 1e-9;
}
const validDimensions = (width: number, height: number) =>
  [width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_STICKER_DIMENSION);
function validSticker(layer: StickerLayer): boolean {
  const { box } = layer;
  if (typeof layer.id !== "string" || layer.id.length === 0 || layer.id.length > 64 || typeof layer.name !== "string" || layer.name.length > 255 ||
    !validDimensions(layer.width, layer.height) || typeof layer.rotation !== "number" || !Number.isFinite(layer.rotation) ||
    layer.rotation <= -180 || layer.rotation > 180) return false;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) || box[2] <= box[0] || box[3] <= box[1]) return false;
  // 外框的宽高比必须与图片一致，宽度在合法范围内：损坏或被篡改的记录不会让贴纸变形。
  const w = box[2] - box[0], h = box[3] - box[1], aspect = layer.width / layer.height, [lo, hi] = widthRange(aspect);
  return Math.abs(w / h - aspect) <= aspect * 0.01 && w >= lo - 1e-6 && w <= hi + 1e-6;
}
function validLayer(layer: PosterLayer): boolean {
  if (layer && layer.kind === "sticker") return validSticker(layer);
  return !!layer && layer.kind === "text" && typeof layer.id === "string" && layer.id.length > 0 && layer.id.length <= 64 &&
    typeof layer.text === "string" && layer.text.length <= MAX_TEXT_LENGTH && !layer.text.includes("\r") && validBox(layer.box) &&
    layer.fontId in FONTS && COLOR.test(layer.color) && ["left", "center", "right"].includes(layer.align) && (layer.weight === 400 || layer.weight === 700);
}
export function validPoster(value: unknown): value is PosterDocument {
  const doc = value as PosterDocument;
  if (!doc || typeof doc !== "object" || !UUID.test(doc.documentId) || !Number.isSafeInteger(doc.revision) || doc.revision < 0 ||
    doc.ratio !== "1:1" || !Array.isArray(doc.layers) || doc.layers.length > MAX_TEXT_LAYERS + MAX_STICKERS) return false;
  const bg = doc.background;
  if (!bg || (bg.kind === "solid" ? !COLOR.test(bg.color) :
    bg.kind !== "image" || !["upload", "result"].includes(bg.source) || typeof bg.name !== "string" || bg.name.length > 255 ||
    ![bg.width, bg.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192))) return false;
  return doc.layers.every(validLayer) && new Set(doc.layers.map(layer => layer.id)).size === doc.layers.length &&
    doc.layers.filter(isText).length <= MAX_TEXT_LAYERS && doc.layers.filter(isSticker).length <= MAX_STICKERS;
}
