import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STICKERS, MAX_TEXT_LAYERS, addSticker, addText, emptyPoster, moveLayer, removeLayer, updateLayer, updateSticker, validPoster,
  type PosterDocument, type StickerLayer,
} from "./poster";
import {
  DEFAULT_STICKER_SIZE, MAX_STICKER_DIMENSION, MIN_STICKER_SIZE, analyzeAlpha, boxCenter, checkAlpha, initialStickerBox, normalizeRotation, stickerBox, widthRange,
} from "./sticker";

const fresh = () => emptyPoster(crypto.randomUUID());
const info = (name = "badge.png", width = 400, height = 400) => ({ name, width, height });
const stickers = (doc: PosterDocument) => doc.layers.filter((l): l is StickerLayer => l.kind === "sticker");
const sticker = (doc: PosterDocument, id: string) => stickers(doc).find(l => l.id === id)!;
const inCanvas = (box: number[]) => box.every(v => v >= -1e-12 && v <= 1 + 1e-12);

/** 一张 width×height 的 RGBA 图，alpha 由函数给出。 */
function image(width: number, height: number, alphaAt: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([200, 30, 30, alphaAt(x, y)], (y * width + x) * 4);
  return data;
}

test("analyzeAlpha and checkAlpha: a real cut-out passes, opaque images and empty images do not", () => {
  const size = 100, centre = (size - 1) / 2;
  const circle = image(size, size, (x, y) => (Math.hypot(x - centre, y - centre) <= 40 ? 255 : 0));
  const stats = analyzeAlpha(circle, size, size);
  assert.ok(stats.transparent > 0.4 && stats.visible > 0.4 && stats.transparent + stats.visible <= 1 + 1e-9);
  assert.equal(checkAlpha(stats), "ok");

  const opaque = image(size, size, () => 255);
  assert.equal(checkAlpha(analyzeAlpha(opaque, size, size)), "sticker_no_alpha", "a plain opaque image has no real transparency");
  // 把灰白棋盘格画进 RGB、alpha 全是 255：看起来像透明，实际没有透明通道。
  const fake = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const v = ((x >> 3) + (y >> 3)) % 2 ? 255 : 204; fake.set([v, v, v, 255], (y * size + x) * 4); }
  assert.equal(checkAlpha(analyzeAlpha(fake, size, size)), "sticker_no_alpha", "a checkerboard baked into RGB is rejected");

  assert.equal(checkAlpha(analyzeAlpha(image(size, size, () => 0), size, size)), "sticker_empty", "fully transparent");
  const speck = image(size, size, (x, y) => (x < 2 && y < 2 ? 255 : 0));
  assert.equal(checkAlpha(analyzeAlpha(speck, size, size)), "sticker_empty", "a handful of visible pixels is not a sticker");
  // 只有半透明（alpha 9～127）：没有“透明”像素，也不算可见。
  assert.equal(checkAlpha(analyzeAlpha(image(size, size, () => 60), size, size)), "sticker_empty");
});

test("a rounded rectangle that fills the image still counts as transparent, an almost full image does not", () => {
  const size = 200, r = 20; // 圆角半径为边长的 10%
  const rounded = image(size, size, (x, y) => {
    const dx = Math.max(r - x, 0, x - (size - 1 - r)), dy = Math.max(r - y, 0, y - (size - 1 - r));
    return Math.hypot(dx, dy) > r ? 0 : 255;
  });
  const stats = analyzeAlpha(rounded, size, size);
  assert.ok(stats.transparent > 0.005 && stats.transparent < 0.02, `corners are ${(stats.transparent * 100).toFixed(2)}%`);
  assert.equal(checkAlpha(stats), "ok");
  const almost = image(size, size, (x, y) => (x === 0 && y === 0 ? 0 : 255));
  assert.equal(checkAlpha(analyzeAlpha(almost, size, size)), "sticker_no_alpha");
  assert.deepEqual(analyzeAlpha(new Uint8ClampedArray(4), 5, 5), { transparent: 0, visible: 0 }, "short data is treated as empty, not read out of bounds");
});

test("normalizeRotation wraps into (-180, 180] and survives bad input", () => {
  assert.equal(normalizeRotation(0), 0); assert.equal(normalizeRotation(90), 90); assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(-180), 180, "-180 and 180 are the same orientation; 180 is the canonical value");
  assert.equal(normalizeRotation(190), -170); assert.equal(normalizeRotation(-190), 170); assert.equal(normalizeRotation(720.04), 0);
  assert.equal(normalizeRotation(12.34), 12.3);
  assert.ok(Object.is(normalizeRotation(-0.01), 0), "no negative zero");
  assert.equal(normalizeRotation(NaN), 0); assert.equal(normalizeRotation(Infinity), 0);
});

test("stickerBox keeps the aspect ratio, the size range and stays inside the canvas for any input", () => {
  for (const aspect of [1, 2, 0.5, 5, 0.2, 16, 1 / 16]) {
    const [lo, hi] = widthRange(aspect);
    assert.ok(lo > 0 && lo <= hi, `range for ${aspect}`);
    for (const [cx, cy, width] of [[0.5, 0.5, 0.4], [0, 0, 5], [1, 1, 5], [-3, 7, 0.001], [0.5, 0.5, NaN], [NaN, NaN, 0.2], [0.99, 0.01, 0.3]]) {
      const box = stickerBox(cx, cy, width, aspect), w = box[2] - box[0], h = box[3] - box[1];
      assert.ok(inCanvas(box), `${aspect} ${[cx, cy, width]} -> ${box}`);
      assert.ok(Math.abs(w / h - aspect) < 1e-9, "aspect kept");
      assert.ok(w >= lo - 1e-12 && w <= hi + 1e-12, "width in range");
      assert.ok(Math.max(w, h) >= MIN_STICKER_SIZE - 1e-12, "long side is not below the minimum");
    }
  }
  const box = stickerBox(0.5, 0.5, 0.4, 1);
  assert.deepEqual(boxCenter(box).map(v => Math.round(v * 1e9) / 1e9), [0.5, 0.5]);
});

test("initialStickerBox sizes by the long side and staggers new stickers", () => {
  const square = initialStickerBox(300, 300, 0), wide = initialStickerBox(800, 200, 0), tall = initialStickerBox(200, 800, 0);
  assert.ok(Math.abs(square[2] - square[0] - DEFAULT_STICKER_SIZE) < 1e-9);
  assert.ok(Math.abs(wide[2] - wide[0] - DEFAULT_STICKER_SIZE) < 1e-9 && Math.abs((wide[3] - wide[1]) - DEFAULT_STICKER_SIZE / 4) < 1e-9);
  assert.ok(Math.abs(tall[3] - tall[1] - DEFAULT_STICKER_SIZE) < 1e-9, "a tall sticker is sized by its height");
  const centres = [0, 1, 2, 3, 4, 5].map(n => boxCenter(initialStickerBox(300, 300, n))[0]);
  assert.equal(new Set(centres.slice(0, 5).map(v => v.toFixed(6))).size, 5, "five different positions");
  assert.equal(centres[5].toFixed(6), centres[0].toFixed(6), "then it wraps around");
  assert.ok(inCanvas(initialStickerBox(16000, 20, 3)), "extreme aspect ratios still fit");
});

test("addSticker places stickers, refuses the ninth, duplicates and bad sizes", () => {
  let doc = fresh();
  for (let i = 0; i < MAX_STICKERS; i++) {
    const next = addSticker(doc, `s${i}`, info(`s${i}.png`));
    assert.notEqual(next, doc); assert.equal(next.revision, doc.revision + 1); doc = next;
  }
  assert.equal(stickers(doc).length, MAX_STICKERS);
  assert.equal(addSticker(doc, "s9", info()), doc, "the ninth sticker is refused");
  const small = addSticker(fresh(), "a", info());
  assert.equal(addSticker(small, "a", info()), small, "duplicate id");
  for (const bad of [{ width: 0, height: 10 }, { width: 10.5, height: 10 }, { width: 10, height: -1 }, { width: MAX_STICKER_DIMENSION + 1, height: 10 }, { width: NaN, height: 10 }]) {
    assert.equal(addSticker(fresh(), "x", { name: "x", ...bad }).layers.length, 0, JSON.stringify(bad));
  }
  assert.equal(sticker(addSticker(fresh(), "x", info("n".repeat(400))), "x").name.length, 255, "long names are cut");
  assert.ok(stickers(doc).every(s => inCanvas(s.box) && s.rotation === 0));
});

test("stickers and text have separate limits and share one stacking order", () => {
  let doc = fresh();
  for (let i = 0; i < MAX_STICKERS; i++) doc = addSticker(doc, `s${i}`, info());
  for (let i = 0; i < MAX_TEXT_LAYERS; i++) doc = addText(doc, `t${i}`, `text ${i}`);
  assert.equal(doc.layers.length, MAX_STICKERS + MAX_TEXT_LAYERS, "eight stickers do not use up the text boxes");
  assert.equal(addText(doc, "t9", "nine"), doc); assert.equal(addSticker(doc, "s9", info()), doc);
  assert.ok(validPoster(doc), "a full poster is valid");
  assert.ok(validPoster(JSON.parse(JSON.stringify(doc))), "and survives a JSON round trip");

  // 新文字框的位置只参考已有的文字框，不受贴纸影响。
  const mixed = addText(addSticker(fresh(), "s", info()), "t", "hello");
  const textBox = (mixed.layers[1] as { box: number[] }).box;
  [0.08, 0.08, 0.92, 0.22].forEach((v, i) => assert.ok(Math.abs(textBox[i] - v) < 1e-9, `box ${textBox}`));

  // 叠放顺序：贴纸可以移到文字下面，也可以移到文字上面。
  assert.deepEqual(mixed.layers.map(l => l.id), ["s", "t"]);
  const down = moveLayer(mixed, "t", "down");
  assert.deepEqual(down.layers.map(l => l.id), ["t", "s"], "text goes below the sticker");
  assert.deepEqual(moveLayer(down, "t", "up").layers.map(l => l.id), ["s", "t"]);
  assert.equal(moveLayer(down, "t", "down"), down, "already at the bottom");
  assert.deepEqual(removeLayer(down, "s").layers.map(l => l.id), ["t"]);
});

test("updateSticker keeps the aspect ratio, stays inside the canvas and ignores no-ops", () => {
  let doc = addSticker(fresh(), "s", info("wide.png", 800, 400));
  const before = sticker(doc, "s"), aspect = 2;
  doc = updateSticker(doc, "s", { cx: 0.3, cy: 0.7 });
  let s = sticker(doc, "s"), [cx, cy] = boxCenter(s.box);
  assert.ok(Math.abs(cx - 0.3) < 1e-9 && Math.abs(cy - 0.7) < 1e-9);
  assert.ok(Math.abs((s.box[2] - s.box[0]) - (before.box[2] - before.box[0])) < 1e-9, "moving does not resize");

  for (const patch of [{ width: 0.6 }, { width: 5 }, { width: 0.0001 }, { cx: -4, cy: 9 }, { cx: 1, width: 0.9 }, { width: NaN }]) {
    const next = updateSticker(doc, "s", patch), t = sticker(next, "s");
    assert.ok(inCanvas(t.box), `${JSON.stringify(patch)} -> ${t.box}`);
    assert.ok(Math.abs((t.box[2] - t.box[0]) / (t.box[3] - t.box[1]) - aspect) < 1e-9, "aspect");
    assert.ok(validPoster(next));
  }
  assert.equal(updateSticker(doc, "s", {}), doc, "empty patch");
  assert.equal(updateSticker(doc, "s", { rotation: 0 }), doc, "same rotation");
  assert.equal(updateSticker(doc, "s", { cx: cx, cy: cy }), doc, "same position");
  assert.equal(updateSticker(doc, "nope", { cx: 0.1 }), doc, "unknown id");
  const rotated = updateSticker(doc, "s", { rotation: 270 });
  assert.equal(sticker(rotated, "s").rotation, -90); assert.equal(rotated.revision, doc.revision + 1);
  assert.deepEqual(sticker(rotated, "s").box, s.box, "rotation alone does not touch the box");
  const edge = updateSticker(doc, "s", { cx: 0, cy: 0 });
  assert.equal(sticker(edge, "s").box[0], 0); assert.equal(updateSticker(edge, "s", { rotation: 45 }).layers[0].kind, "sticker");
  s = sticker(edge, "s"); [cx, cy] = boxCenter(s.box);
  assert.equal(updateSticker(edge, "s", { rotation: s.rotation }), edge, "a box at the edge is not nudged by floating point noise");
});

test("updateLayer only edits text; updateSticker only edits stickers", () => {
  const doc = addText(addSticker(fresh(), "s", info()), "t", "hi");
  assert.equal(updateLayer(doc, "s", { text: "x" }), doc, "a sticker is not a text layer");
  assert.equal(updateSticker(doc, "t", { cx: 0.2 }), doc, "a text layer is not a sticker");
});

test("validPoster accepts stored stickers and rejects tampered ones", () => {
  const doc = addSticker(addText(fresh(), "t", "hi"), "s", info("a.png", 300, 200));
  assert.ok(validPoster(JSON.parse(JSON.stringify(doc))));
  const mutate = (change: (layer: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(doc)); change(copy.layers[1]); return validPoster(copy);
  };
  assert.equal(mutate(() => {}), true);
  assert.equal(mutate(l => { l.rotation = 200; }), false, "rotation out of range");
  assert.equal(mutate(l => { l.rotation = -180; }), false, "-180 is not canonical");
  assert.equal(mutate(l => { l.rotation = "10"; }), false);
  assert.equal(mutate(l => { l.width = 0; }), false);
  assert.equal(mutate(l => { l.height = 1.5; }), false);
  assert.equal(mutate(l => { l.name = 5; }), false);
  assert.equal(mutate(l => { l.name = "n".repeat(300); }), false);
  assert.equal(mutate(l => { l.box = [0.1, 0.1, 0.9, 0.9]; }), false, "wrong aspect ratio would stretch the image");
  assert.equal(mutate(l => { l.box = [0.2, 0.2, 0.2, 0.4]; }), false, "empty box");
  assert.equal(mutate(l => { l.box = [-0.1, 0, 0.4, 0.267]; }), false, "outside the canvas");
  assert.equal(mutate(l => { l.box = [0, 0, 0.001, 0.00067]; }), false, "far below the minimum size");
  assert.equal(mutate(l => { l.kind = "sparkle"; }), false);
  const copy = JSON.parse(JSON.stringify(doc)); copy.layers.push({ ...copy.layers[1] });
  assert.equal(validPoster(copy), false, "duplicate ids");
  let many = fresh(); for (let i = 0; i < MAX_STICKERS; i++) many = addSticker(many, `s${i}`, info());
  const extra = JSON.parse(JSON.stringify(many)); extra.layers.push({ ...extra.layers[0], id: "extra" });
  assert.equal(validPoster(extra), false, "nine stickers");
  // 只有文字的旧工程（贴纸功能之前保存的）仍然有效。
  assert.ok(validPoster(JSON.parse(JSON.stringify(addText(fresh(), "t", "old")))));
});
