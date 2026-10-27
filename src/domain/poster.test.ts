import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TEXT_LAYERS, MAX_TEXT_LENGTH, MIN_BOX_SIZE, addText, cleanText, defaultBox, emptyPoster, fitText, moveBox, moveLayer, normalizeBox,
  nextBox, removeLayer, resizeBox, setBackground, updateLayer, validPoster, wrapText, type Measure, type PosterDocument,
} from "./poster";

// 确定的假度量：中日韩字符宽 1em，其余 0.6em，空格 0.3em。不依赖浏览器字体，结果可重复。
const measure: Measure = (text, size) =>
  [...text].reduce((sum, ch) => sum + (/[⺀-鿿]/.test(ch) ? 1 : ch === " " ? 0.3 : 0.6) * size, 0);
const fresh = () => emptyPoster(crypto.randomUUID());
const withLayers = (n: number) => { let doc = fresh(); for (let i = 0; i < n; i++) doc = addText(doc, `layer-${i}`, `text ${i}`); return doc; };
const inside = (box: number[]) => box.every(v => v >= 0 && v <= 1) && box[2] - box[0] >= MIN_BOX_SIZE - 1e-9 && box[3] - box[1] >= MIN_BOX_SIZE - 1e-9;

test("normalizeBox keeps every box inside the canvas and above the minimum size", () => {
  assert.deepEqual(normalizeBox([0.1, 0.2, 0.5, 0.6]), [0.1, 0.2, 0.5, 0.6]);
  assert.deepEqual(normalizeBox([0.5, 0.6, 0.1, 0.2]), [0.1, 0.2, 0.5, 0.6], "reversed corners are swapped");
  for (const input of [[-1, -1, 2, 2], [0.5, 0.5, 0.5, 0.5], [0.99, 0.99, 1, 1], [NaN, 0, 1, 1], [0, 0, Infinity, 0.001]]) {
    const box = normalizeBox(input); assert.ok(inside(box), JSON.stringify(input) + " -> " + JSON.stringify(box));
  }
  const edge = normalizeBox([0.99, 0.99, 1, 1]);
  assert.equal(edge[2], 1); assert.ok(Math.abs(edge[2] - edge[0] - MIN_BOX_SIZE) < 1e-9, "a tiny box at the corner grows inward, not outward");
});

test("moveBox keeps the size and stops at the canvas edge; resizeBox keeps the top-left corner", () => {
  const box: [number, number, number, number] = [0.2, 0.2, 0.5, 0.4];
  const moved = moveBox(box, 0.1, -0.05);
  assert.ok(Math.abs(moved[2] - moved[0] - 0.3) < 1e-9 && Math.abs(moved[3] - moved[1] - 0.2) < 1e-9);
  assert.deepEqual(moveBox(box, 5, 5).map(v => Math.round(v * 1e6) / 1e6), [0.7, 0.8, 1, 1]);
  assert.deepEqual(moveBox(box, -5, -5).map(v => Math.round(v * 1e6) / 1e6), [0, 0, 0.3, 0.2]);
  const grown = resizeBox(box, 0.9, 0.9); assert.deepEqual([grown[0], grown[1]], [0.2, 0.2]); assert.deepEqual([grown[2], grown[3]], [0.9, 0.9]);
  const shrunk = resizeBox(box, 0.0, 0.0); assert.ok(inside(shrunk)); assert.deepEqual([shrunk[0], shrunk[1]], [0.2, 0.2]);
  assert.ok(resizeBox(box, 9, 9)[2] <= 1);
});

test("addText places up to eight boxes inside the canvas, and refuses the ninth and duplicate ids", () => {
  let doc = fresh();
  for (let i = 0; i < MAX_TEXT_LAYERS; i++) { doc = addText(doc, `a${i}`, "hi"); assert.ok(inside(doc.layers[i].box), `box ${i}`); assert.ok(inside(defaultBox(i))); }
  assert.equal(doc.layers.length, MAX_TEXT_LAYERS); assert.equal(doc.revision, MAX_TEXT_LAYERS);
  assert.equal(addText(doc, "ninth", "x"), doc, "the ninth box returns the same document");
  assert.equal(addText(withLayers(1), "layer-0", "dup").layers.length, 1, "duplicate ids are refused");
  const shown = addText(fresh(), "z", "a\r\nb", { color: "#ff0000", weight: 400 }); assert.equal(shown.layers[0].text, "a\nb"); assert.equal(shown.layers[0].color, "#FF0000");
});

test("a new box goes below the existing ones; when there is no room it falls back inside the canvas", () => {
  let doc = addText(fresh(), "title", "t", { box: [0.08, 0.08, 0.92, 0.24] });
  doc = addText(doc, "sub", "s", { box: [0.08, 0.26, 0.7, 0.4] });
  const placed = nextBox(doc.layers);
  assert.ok(Math.abs(placed[1] - 0.42) < 1e-9, "starts 0.02 below the lowest existing box");
  assert.ok(doc.layers.every(layer => placed[1] >= layer.box[3]), "does not overlap any existing box");
  const crowded = addText(doc, "low", "x", { box: [0.08, 0.84, 0.92, 0.98] });
  const fallback = nextBox(crowded.layers);
  assert.deepEqual(fallback, defaultBox(crowded.layers.length)); assert.ok(inside(fallback), "fallback stays inside the canvas");
  assert.deepEqual(nextBox([]), defaultBox(0), "the first box uses the default slot");
});

test("updateLayer validates input, ignores no-ops and unknown ids", () => {
  const doc = withLayers(2), id = doc.layers[0].id;
  assert.equal(updateLayer(doc, "missing", { text: "x" }), doc);
  assert.equal(updateLayer(doc, id, { text: doc.layers[0].text }), doc, "no change keeps the same object and revision");
  const bad = updateLayer(doc, id, { color: "red", fontId: "comic" as never, align: "justify" as never, weight: 500 as never });
  assert.equal(bad, doc, "invalid fields are ignored");
  const longText = "字".repeat(MAX_TEXT_LENGTH + 50), next = updateLayer(doc, id, { text: longText });
  assert.equal(next.layers[0].text.length, MAX_TEXT_LENGTH); assert.equal(next.revision, doc.revision + 1);
  assert.equal(cleanText("a\r\nb\rc"), "a\nb\nc");
  assert.ok(inside(updateLayer(doc, id, { box: [-5, -5, 0, 0] }).layers[0].box), "boxes are normalized on update");
  assert.equal(next.layers[1], doc.layers[1], "other layers are untouched");
});

test("removeLayer and moveLayer keep order stable and clamp at the ends", () => {
  const doc = withLayers(3), ids = doc.layers.map(layer => layer.id);
  assert.deepEqual(removeLayer(doc, ids[1]).layers.map(l => l.id), [ids[0], ids[2]]);
  assert.equal(removeLayer(doc, "missing"), doc);
  assert.deepEqual(moveLayer(doc, ids[0], "up").layers.map(l => l.id), [ids[1], ids[0], ids[2]]);
  assert.equal(moveLayer(doc, ids[2], "up"), doc, "top layer cannot move further up");
  assert.equal(moveLayer(doc, ids[0], "down"), doc, "bottom layer cannot move further down");
  assert.equal(moveLayer(doc, "missing", "up"), doc);
});

test("setBackground accepts valid colors and images and ignores invalid colors", () => {
  const doc = fresh();
  assert.equal(setBackground(doc, { kind: "solid", color: "nope" }), doc);
  const colored = setBackground(doc, { kind: "solid", color: "#112233" }); assert.equal(colored.revision, 1);
  const image = setBackground(colored, { kind: "image", source: "result", name: "r.png", width: 1024, height: 1024 });
  assert.equal(image.background.kind, "image"); assert.ok(validPoster(image));
});

test("wrapText keeps explicit newlines and blank lines, breaks CJK per character and Latin at spaces", () => {
  assert.deepEqual(wrapText("a\n\nb", 1000, 10, measure), ["a", "", "b"]);
  assert.deepEqual(wrapText("新品上市限时优惠", 40, 10, measure), ["新品上市", "限时优惠"], "4 CJK chars of 10px fit in 40px");
  // 10px 下 "hello"=30、"hello big"=51、"hello big world"=84：51 放得下 70，84 放不下，所以 "world" 另起一行。
  assert.deepEqual(wrapText("hello big world", 70, 10, measure), ["hello big", "world"]);
  const hard = wrapText("supercalifragilistic", 30, 10, measure);
  assert.ok(hard.length > 1 && hard.join("") === "supercalifragilistic" && hard.every(line => measure(line, 10) <= 30), "an over-long word is split by characters without losing any");
  for (const line of wrapText("价格 ¥199 限时 price 99.9 now", 55, 10, measure)) assert.ok(measure(line, 10) <= 55, `line "${line}" fits`);
  assert.equal(wrapText("价格¥199", 1000, 10, measure).join(""), "价格¥199", "no characters are dropped or reordered");
});

test("wrapText never loses non-space characters, even for awkward widths", () => {
  const sample = "夏季新品 Summer Sale 限时 ¥199.00 起\n第二行 ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const width of [12, 25, 40, 77, 160, 1000]) {
    const lines = wrapText(sample, width, 10, measure);
    assert.equal(lines.join("").replace(/\s/g, ""), sample.replace(/\s/g, ""), `width ${width}`);
  }
});

test("fitText picks the largest size that fits and flags text that cannot fit", () => {
  const big = fitText("新品", 600, 300, measure), small = fitText("新品", 150, 75, measure);
  assert.ok(big.fontSize > small.fontSize, "a larger box gets a larger font");
  assert.ok(big.lines.length * big.lineHeight <= 300 && measure(big.lines[0], big.fontSize) <= 600);
  assert.equal(big.overflow, false);
  // 最大字号再加 1 就放不下：说明取到的是上限，不是随便一个能放下的值。
  const tooBig = big.fontSize + 1, lines = wrapText("新品", 600, tooBig, measure);
  assert.ok(lines.length * tooBig * 1.25 > 300 || lines.some(l => measure(l, tooBig) > 600));
  assert.ok(fitText("a long headline that needs several lines to fit", 300, 300, measure).lines.length > 1);
  const impossible = fitText("字".repeat(300), 40, 40, measure); assert.equal(impossible.overflow, true); assert.equal(impossible.fontSize, 8);
  assert.ok(fitText("x", 100, 100, measure, { max: 30 }).fontSize <= 30, "an explicit upper bound is respected");
  const narrower = fitText("Summer collection", 200, 200, measure), wider = fitText("Summer collection", 400, 200, measure);
  assert.ok(wider.fontSize >= narrower.fontSize, "a wider box never shrinks the font");
  assert.ok(fitText("", 100, 100, measure).lines.length <= 1, "empty text does not throw");
});

test("stored poster records survive a JSON round trip but corrupt ones are rejected", () => {
  let doc = addText(addText(fresh(), "t1", "标题"), "t2", "Price ¥199\nsecond line", { align: "right", fontId: "serif", weight: 400 });
  doc = setBackground(doc, { kind: "image", source: "upload", name: "a.png", width: 800, height: 600 });
  assert.ok(validPoster(JSON.parse(JSON.stringify(doc))));
  const bad = (change: (copy: PosterDocument) => void) => { const copy = structuredClone(doc); change(copy); return validPoster(copy); };
  assert.equal(validPoster(null), false); assert.equal(validPoster({}), false);
  assert.equal(bad(d => { d.documentId = "../x"; }), false);
  assert.equal(bad(d => { d.revision = -1; }), false);
  assert.equal(bad(d => { (d as { ratio: string }).ratio = "3:4"; }), false, "only 1:1 is open");
  assert.equal(bad(d => { d.layers[0].box = [0.5, 0.5, 0.51, 0.51]; }), false, "below the minimum box size");
  assert.equal(bad(d => { d.layers[0].box = [0, 0, 2, 1]; }), false);
  assert.equal(bad(d => { d.layers[0].color = "blue"; }), false);
  assert.equal(bad(d => { d.layers[0].text = "x".repeat(MAX_TEXT_LENGTH + 1); }), false);
  assert.equal(bad(d => { d.layers[0].text = "a\r\nb"; }), false, "CRLF is normalized before it is ever stored");
  assert.equal(bad(d => { d.layers[1].id = d.layers[0].id; }), false, "duplicate ids");
  assert.equal(bad(d => { d.layers = Array.from({ length: MAX_TEXT_LAYERS + 1 }, (_, i) => ({ ...d.layers[0], id: `extra-${i}` })); }), false, "more than eight layers (built by hand, addText would refuse)");
  assert.equal(bad(d => { d.layers[0].fontId = "comic" as never; }), false);
  assert.equal(bad(d => { (d.background as { width: number }).width = 0; }), false);
  assert.equal(bad(d => { d.background = { kind: "solid", color: "#12" }; }), false);
});
