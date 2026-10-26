import test from "node:test";
import assert from "node:assert/strict";
import {
  BRUSH, FEATHER, MAX_COLORS, MAX_POINTS, MAX_STROKES, TABLE_SIZE, WIDE_SHIFT, accumulateLightness, addStroke, buildTable, clearStrokes, coverageOf, downscaleMask,
  brushRadius, emptyEdit, featherMask, featherRadius, gamutMap, isWideShift, labToLinear, lightnessOfLuminance, lightnessShift, mapLightness, meanLightness, normalizeColors, parseHex, recolorPixels,
  redo, rgbToLab, sanitizeStrokes, toHex, undo, validStroke, type LightnessSum, type Stroke,
} from "./recolor";

const stroke = (overrides: Partial<Stroke> = {}): Stroke => ({ erase: false, radius: 0.05, points: [0.2, 0.2, 0.4, 0.4], ...overrides });
/** 一张 width×height 的纯色 RGBA 图。 */
const solid = (width: number, height: number, [r, g, b]: number[], alpha = 255) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, alpha], i * 4);
  return data;
};
/** 确定的伪随机数（mulberry32），测试结果可重复。 */
function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const meanOf = (data: Uint8ClampedArray, mask: Uint8Array) => {
  const sum: LightnessSum = { sum: 0, weight: 0 };
  accumulateLightness(data, mask, 0, mask.length, sum);
  return meanLightness(sum);
};

test("hex helpers accept only #RRGGBB and normalizeColors cleans, dedupes and caps the list", () => {
  assert.deepEqual(parseHex("#ff8000"), [255, 128, 0]);
  assert.equal(parseHex("ff8000"), null); assert.equal(parseHex("#ff80"), null); assert.equal(parseHex("#gg0000"), null);
  assert.equal(toHex([255, 128, 0]), "#FF8000"); assert.equal(toHex([0, 0, 0]), "#000000");
  assert.deepEqual(normalizeColors(["#ff0000", "#FF0000", "red", 42, "#00ff00", null]), ["#FF0000", "#00FF00"]);
  const many = Array.from({ length: 20 }, (_, i) => `#${(i * 7 + 16).toString(16).padStart(2, "0")}0000`);
  assert.equal(normalizeColors(many).length, MAX_COLORS);
});

test("rgbToLab matches the published sRGB D65 reference values", () => {
  const close = (actual: number[], expected: number[], tolerance: number) =>
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual.map(v => v.toFixed(2))} vs ${expected}`));
  close(rgbToLab([255, 255, 255]), [100, 0, 0], 0.05);
  close(rgbToLab([0, 0, 0]), [0, 0, 0], 0.01);
  close(rgbToLab([255, 0, 0]), [53.24, 80.09, 67.2], 0.1);
  close(rgbToLab([0, 255, 0]), [87.73, -86.18, 83.18], 0.15);
  close(rgbToLab([0, 0, 255]), [32.3, 79.19, -107.86], 0.15);
  close(rgbToLab([128, 128, 128]), [53.59, 0, 0], 0.05);
});

test("Lab to linear sRGB round-trips every in-gamut color, and gamutMap pulls others back without changing lightness", () => {
  const rand = random(1);
  for (let i = 0; i < 500; i++) {
    const rgb: [number, number, number] = [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
    const [L, a, b] = rgbToLab(rgb);
    const encoded = labToLinear(L, a, b).map(v => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255));
    encoded.forEach((value, c) => assert.ok(Math.abs(value - rgb[c]) <= 1, `round trip of ${rgb} gave ${encoded}`));
  }
  // 非常饱和的黄色在 L=40 时放不进 sRGB：映射后必须全部落在 [0,1]，明度不变。
  const mapped = gamutMap(40, 0, 120);
  assert.ok(mapped.every(v => v >= -1e-3 && v <= 1.001), mapped.join());
  // 映射结果是线性光：直接由相对亮度 Y 算回 Lab 的 L，明度应当仍是 40；色相方向（b > 0，偏黄）保持。
  const [r, g, blue] = mapped, Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * blue;
  assert.ok(Math.abs(lightnessOfLuminance(Y) - 40) < 0.5, `lightness ${lightnessOfLuminance(Y)}`);
  assert.ok(r > blue && g > blue, "still a yellow");
});

test("mapLightness: the mean lands on the target, nothing is clipped, and the order of tones is never reversed", () => {
  for (const [source, target] of [[20, 90], [80, 25], [50, 50], [5, 95], [95, 5], [60, 0], [40, 100]]) {
    assert.ok(Math.abs(mapLightness(source, source, target) - target) < 1e-9, `mean ${source} -> ${target}`);
    // 变亮时白色不动，变暗时黑色不动；另一端被推向目标，但始终留在 0～100 以内。
    if (target >= source) assert.ok(Math.abs(mapLightness(100, source, target) - 100) < 1e-9, "white stays white when lightening");
    else assert.ok(Math.abs(mapLightness(0, source, target)) < 1e-9, "black stays black when darkening");
    let previous = -Infinity;
    for (let L = 0; L <= 100; L += 0.5) {
      const mapped = mapLightness(L, source, target);
      assert.ok(mapped >= previous - 1e-9, `monotone at ${L} for ${source}->${target}`); assert.ok(mapped >= -1e-9 && mapped <= 100 + 1e-9);
      previous = mapped;
    }
  }
});

test("buildTable: a flat region becomes exactly the target color, for light, dark and saturated targets", () => {
  for (const hex of ["#D32F2F", "#1E88E5", "#2E7D32", "#F9A825", "#7B1FA2", "#FFFFFF", "#000000", "#808080", "#FF00FF", "#102030"]) {
    // 源是一块中灰：它的平均明度就是它自己的明度，换色后应当正好是目标色（允许量化带来的 ±1）。
    const data = solid(4, 4, [120, 120, 120]), mask = new Uint8Array(16).fill(255);
    const L = meanOf(data, mask)!;
    const out = new Uint8ClampedArray(data);
    recolorPixels(data, mask, buildTable(hex, L), out, 0, 16);
    const expected = parseHex(hex)!;
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[c] - expected[c]) <= 1, `${hex}: got ${[...out.slice(0, 3)]}`);
    assert.equal(out[3], 255, "alpha untouched");
  }
});

test("recoloring keeps the shading: lightness order is preserved and the mean moves to the target", () => {
  // 一条从暗到亮的灰度渐变，当作有明暗起伏的商品。
  const width = 256, data = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) data.set([40 + x * 0.5, 40 + x * 0.5, 40 + x * 0.5, 255], x * 4);
  const mask = new Uint8Array(width).fill(255), sourceL = meanOf(data, mask)!, hex = "#C62828";
  const out = new Uint8ClampedArray(data);
  recolorPixels(data, mask, buildTable(hex, sourceL), out, 0, width);
  const lightness = Array.from({ length: width }, (_, x) => rgbToLab([out[x * 4], out[x * 4 + 1], out[x * 4 + 2]])[0]);
  for (let x = 1; x < width; x++) assert.ok(lightness[x] >= lightness[x - 1] - 0.6, `order broken at ${x}: ${lightness[x - 1]} -> ${lightness[x]}`);
  assert.ok(lightness[width - 1] - lightness[0] > 10, "the gradient is still there");
  const targetL = rgbToLab(parseHex(hex)!)[0];
  assert.ok(Math.abs(meanOf(out, mask)! - targetL) < 1.5, `mean ${meanOf(out, mask)} vs target ${targetL}`);
  // 整体偏向目标色相：红色目标下，红通道应高于绿、蓝通道（中段）。
  const mid = (width >> 1) * 4;
  assert.ok(out[mid] > out[mid + 1] + 20 && out[mid] > out[mid + 2] + 20);
});

test("pixels outside the mask are byte-identical, partial mask values blend, alpha is never changed", () => {
  const rand = random(7), count = 64 * 64, data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);
  const mask = new Uint8Array(count);
  for (let i = 0; i < count; i++) mask[i] = i % 3 === 0 ? 0 : i % 3 === 1 ? 255 : 100;
  const out = new Uint8ClampedArray(data);
  recolorPixels(data, mask, buildTable("#1E88E5", meanOf(data, mask)!), out, 0, count);
  let changed = 0, partial = 0;
  for (let i = 0; i < count; i++) {
    const same = [0, 1, 2, 3].every(c => out[i * 4 + c] === data[i * 4 + c]);
    assert.equal(out[i * 4 + 3], data[i * 4 + 3], "alpha");
    if (mask[i] === 0) assert.ok(same, `pixel ${i} is outside the mask and must not change`);
    else { if (!same) changed++; if (mask[i] === 100) partial++; }
  }
  assert.ok(changed > count / 2, "masked pixels did change");
  // 半透明的遮罩像素恰好落在原像素和 255 遮罩结果之间。
  const probe = (m: number) => { const d = solid(1, 1, [200, 100, 50]), o = new Uint8ClampedArray(d), table = buildTable("#1E88E5", 60); recolorPixels(d, new Uint8Array([m]), table, o, 0, 1); return [...o.slice(0, 3)]; };
  const none = probe(0), half = probe(128), full = probe(255);
  assert.deepEqual(none, [200, 100, 50]);
  for (let c = 0; c < 3; c++) assert.ok(half[c] >= Math.min(none[c], full[c]) - 1 && half[c] <= Math.max(none[c], full[c]) + 1, `channel ${c}: ${none[c]} ${half[c]} ${full[c]}`);
  assert.ok(partial > 0);
});

test("fully transparent pixels are skipped and do not pull the average lightness", () => {
  const data = new Uint8ClampedArray([255, 255, 255, 0, 20, 20, 20, 255]), mask = new Uint8Array([255, 255]);
  const L = meanOf(data, mask)!, expected = rgbToLab([20, 20, 20])[0];
  assert.ok(Math.abs(L - expected) < 0.01, `${L} vs ${expected}`);
  const out = new Uint8ClampedArray(data);
  recolorPixels(data, mask, buildTable("#FF0000", L), out, 0, 2);
  assert.deepEqual([...out.slice(0, 4)], [255, 255, 255, 0], "invisible pixel left alone");
  assert.notDeepEqual([...out.slice(4, 8)], [20, 20, 20, 255]);
  assert.equal(meanLightness({ sum: 0, weight: 0 }), null, "an empty mask has no mean");
  assert.equal(meanOf(data, new Uint8Array(2)), null);
});

test("processing in slices gives the same bytes as one pass", () => {
  const rand = random(3), count = 5000, data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rand() * 256);
  const mask = new Uint8Array(count).map(() => (rand() < 0.5 ? 255 : Math.floor(rand() * 255)));
  const whole = new Uint8ClampedArray(data), sliced = new Uint8ClampedArray(data), table = buildTable("#7B1FA2", 55);
  recolorPixels(data, mask, table, whole, 0, count);
  for (let start = 0; start < count; start += 777) recolorPixels(data, mask, table, sliced, start, Math.min(count, start + 777));
  assert.deepEqual(sliced, whole);
  const one: LightnessSum = { sum: 0, weight: 0 }, parts: LightnessSum = { sum: 0, weight: 0 };
  accumulateLightness(data, mask, 0, count, one);
  for (let start = 0; start < count; start += 777) accumulateLightness(data, mask, start, Math.min(count, start + 777), parts);
  assert.ok(Math.abs(meanLightness(one)! - meanLightness(parts)!) < 1e-9);
});

test("a wide lightness jump is reported, a nearby color is not", () => {
  const blackL = rgbToLab([20, 20, 20])[0];
  assert.ok(isWideShift(blackL, "#FFFFFF") && lightnessShift(blackL, "#FFFFFF") > WIDE_SHIFT);
  assert.ok(!isWideShift(blackL, "#2A2A40"));
  assert.ok(!isWideShift(53, "#D32F2F"));
  assert.equal(lightnessShift(50, "bad"), 0);
  assert.equal(buildTable("#336699", 40).length, TABLE_SIZE * 3);
  assert.throws(() => buildTable("blue", 40), /invalid_color/);
});

test("featherMask: zero radius is a no-op, blur is symmetric, stays inside the image and keeps a solid interior solid", () => {
  const width = 61, height = 41, mask = new Uint8Array(width * height);
  assert.equal(featherMask(mask, width, height, 0), mask, "radius 0 returns the same array");
  // 三次半径 2 的方框模糊，影响范围是 6 像素：31×21 的方块中心一定在影响范围之外。
  for (let y = 10; y <= 30; y++) for (let x = 15; x <= 45; x++) mask[y * width + x] = 255;
  const before = mask.slice();
  const blurred = featherMask(mask, width, height, 2);
  assert.deepEqual(mask, before, "the input is not modified");
  assert.equal(blurred[20 * width + 30], 255, "the interior of a big block stays solid");
  assert.ok(blurred[20 * width + 13] > 0 && blurred[20 * width + 13] < 255, "the edge becomes soft and spreads outward");
  assert.equal(blurred[0], 0, "far away stays zero");
  assert.equal(blurred[20 * width + 5], 0, "beyond the blur reach stays zero");
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    assert.equal(blurred[y * width + x], blurred[(height - 1 - y) * width + x], `vertical symmetry at ${x},${y}`);
    assert.equal(blurred[y * width + x], blurred[y * width + (width - 1 - x)], `horizontal symmetry at ${x},${y}`);
  }
  // 贴着图像边缘的遮罩也要正确：窗口外按 0 算，不会读到越界数据。
  const edge = new Uint8Array(width * height).fill(255), softEdge = featherMask(edge, width, height, 3);
  assert.ok(softEdge[20 * width + 30] === 255 && softEdge[0] < 255 && softEdge[0] > 0, "corner pixel fades because outside counts as empty");
  assert.ok([...softEdge].every(v => v >= 0 && v <= 255));
});

test("coverageOf and downscaleMask", () => {
  const mask = new Uint8Array(100);
  mask.fill(255, 0, 25); mask.fill(127, 25, 50);
  assert.equal(coverageOf(mask), 0.25, "only values >= 128 count");
  assert.equal(coverageOf(new Uint8Array(0)), 0);
  const small = downscaleMask(Uint8Array.from({ length: 16 }, (_, i) => (i % 4 < 2 ? 255 : 0)), 4, 4, 2, 2);
  assert.deepEqual([...small], [255, 0, 255, 0]);
  assert.equal(downscaleMask(new Uint8Array(9).fill(90), 3, 3, 1, 1)[0], 90);
});

test("stroke history: add, undo, redo, clear, limits and sanitising", () => {
  let edit = emptyEdit();
  const a = stroke({ points: [0.1, 0.1, 0.2, 0.2] }), b = stroke({ erase: true, points: [0.3, 0.3] }), c = stroke({ points: [0.5, 0.5, 0.6, 0.6] });
  edit = addStroke(addStroke(addStroke(edit, a), b), c);
  assert.deepEqual(edit.strokes, [a, b, c]);
  edit = undo(edit); assert.deepEqual(edit.strokes, [a, b]); assert.deepEqual(edit.undone, [c]);
  edit = redo(edit); assert.deepEqual(edit.strokes, [a, b, c]); assert.deepEqual(edit.undone, []);
  assert.equal(redo(edit), edit, "nothing to redo returns the same object");
  assert.equal(undo(emptyEdit()).strokes.length, 0);
  edit = undo(edit); edit = addStroke(edit, stroke({ points: [0.9, 0.9] }));
  assert.deepEqual(edit.undone, [], "a new stroke clears the redo stack");

  const cleared = clearStrokes(edit);
  assert.deepEqual(cleared.strokes, []);
  let restored = cleared;
  for (let i = 0; i < edit.strokes.length; i++) restored = redo(restored);
  assert.deepEqual(restored.strokes, edit.strokes, "redo after clear restores the strokes in order");
  assert.equal(clearStrokes(emptyEdit()).strokes.length, 0);

  assert.equal(addStroke(emptyEdit(), stroke({ points: [2, 0] })).strokes.length, 0, "an out-of-range stroke is not recorded");
  const bad: unknown[] = [null, 4, {}, stroke({ radius: 0 }), stroke({ radius: 0.9 }), stroke({ points: [] }), stroke({ points: [0.1] }), stroke({ points: [0.1, 1.5] }), stroke({ points: [NaN, 0.2] }), { ...stroke(), erase: "yes" }];
  for (const value of bad) assert.equal(validStroke(value), false, JSON.stringify(value));
  assert.deepEqual(sanitizeStrokes([a, "nope", b, { radius: 1 }]), [a, b]);
  assert.deepEqual(sanitizeStrokes("not an array"), []);

  let full = emptyEdit();
  for (let i = 0; i < MAX_STROKES + 10; i++) full = addStroke(full, stroke());
  assert.equal(full.strokes.length, MAX_STROKES, "stroke count is capped");
  const huge = stroke({ points: Array.from({ length: (MAX_POINTS + 1) * 2 }, () => 0.5) });
  assert.equal(addStroke(emptyEdit(), huge).strokes.length, 0, "one stroke over the point budget is refused");
  const nearly = addStroke(emptyEdit(), stroke({ points: Array.from({ length: (MAX_POINTS - 1) * 2 }, () => 0.5) }));
  assert.equal(nearly.strokes.length, 1);
  assert.equal(addStroke(nearly, stroke({ points: [0.1, 0.1, 0.2, 0.2, 0.3, 0.3] })), nearly, "the total point budget is enforced across strokes");
});

test("brush and feather sliders map to resolution-independent radii", () => {
  assert.equal(brushRadius(BRUSH.min), BRUSH.min / 2048); assert.equal(brushRadius(9999), BRUSH.max / 2048); assert.equal(brushRadius(-5), BRUSH.min / 2048);
  assert.ok(validStroke(stroke({ radius: brushRadius(BRUSH.min) })) && validStroke(stroke({ radius: brushRadius(BRUSH.max) })), "every slider value is a valid stroke radius");
  assert.equal(featherRadius(0, 4096), 0);
  assert.equal(featherRadius(FEATHER.initial, 1024), 1);
  assert.equal(featherRadius(FEATHER.initial, 4096), 4, "bigger images get a proportionally bigger radius");
  assert.equal(featherRadius(99, 1024), featherRadius(FEATHER.max, 1024), "clamped to the maximum");
});
