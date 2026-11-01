import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  DEFAULT_PLAN, MAX_BATCH_PRODUCTS, SCALE_FACTOR, SUBJECT_LIMITS, analyzeSubject, batchActive, batchBudget, batchCounts, batchMatches, batchRequestFor, checkSubject,
  entryAspect, entryOutcome, failedEntryIds, included, placeSubject, remoteBatchValid, remoteZipName, summaryActive, summaryIsLocal, validBatchDraft, validGroupSummaries, zipFiles, zipName,
  type BatchDraft, type BatchEntryRecord, type CompositionRule,
} from "./batch";
import type { ServiceBatch, ServiceBatchItem, ServiceGroupSummary } from "./service-contracts";

const id = () => crypto.randomUUID();
const rules: CompositionRule[] = [];
for (const subjectScale of ["s", "m", "l"] as const) for (const anchor of ["bottom", "center"] as const) for (const negativeSpace of ["none", "left", "right", "top"] as const) rules.push({ subjectScale, anchor, negativeSpace });
const entry = (over: Partial<BatchEntryRecord> = {}): BatchEntryRecord => ({ entryId: id(), documentId: id(), fileName: "shoe-01.jpg", stage: "ready", sourceAssetId: id(),
  foregroundAssetId: id(), bounds: { x: 10, y: 20, width: 600, height: 400 }, excluded: false, ...over });
const close = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
/** 与服务端 jobRequest() 对放置的校验相同：边距 2%、不越界；宽高比在 0.1% 以内。 */
const serverAccepts = (p: { x: number; y: number; width: number; height: number }, aspect: number, canvas = { width: 1024, height: 1024 }) =>
  p.x >= 0.02 - 1e-12 && p.y >= 0.02 - 1e-12 && p.width > 0 && p.height > 0 && p.x + p.width <= 0.980001 && p.y + p.height <= 0.980001 &&
  Math.abs((p.width * canvas.width) / (p.height * canvas.height) / aspect - 1) <= 0.001;

test("placeSubject: the documented example (square subject, medium, bottom, no negative space)", () => {
  const p = placeSubject(1, DEFAULT_PLAN.composition);
  close(p.width, 0.96 * SCALE_FACTOR.m); close(p.height, p.width);
  close(p.x, (1 - p.width) / 2); close(p.y + p.height, 0.92, 1e-12);
  const centred = placeSubject(1, { ...DEFAULT_PLAN.composition, anchor: "center" });
  close(centred.y, (1 - centred.height) / 2);
  const wide = placeSubject(2, DEFAULT_PLAN.composition), tall = placeSubject(0.5, DEFAULT_PLAN.composition);
  close(wide.width, 0.576); close(wide.height, 0.288); close(tall.height, 0.576); close(tall.width, 0.288);
});

test("placeSubject: every rule and aspect ratio stays inside the contract, keeps the ratio and respects the negative space", () => {
  for (const canvas of [{ width: 1024, height: 1024 }, { width: 768, height: 1024 }, { width: 576, height: 1024 }, { width: 1024, height: 576 }])
    for (const rule of rules) for (const aspect of [0.1, 0.25, 0.5, 0.8, 1, 1.25, 2, 4, 10]) {
      const p = placeSubject(aspect, rule, canvas), label = `${canvas.width}x${canvas.height} ${JSON.stringify(rule)} a=${aspect}`;
      assert.ok(serverAccepts(p, aspect, canvas), `contract: ${label} -> ${JSON.stringify(p)}`);
      if (rule.negativeSpace === "left") assert.ok(p.x >= 0.35 - 1e-12, "left space " + label);
      if (rule.negativeSpace === "right") assert.ok(p.x + p.width <= 0.65 + 1e-12, "right space " + label);
      if (rule.negativeSpace === "top") assert.ok(p.y >= 0.35 - 1e-12, "top space " + label);
      if (rule.anchor === "bottom" && rule.negativeSpace !== "top") assert.ok(p.y + p.height <= 0.92 + 1e-9, "bottom gap " + label);
    }
});

test("placeSubject: bigger scale means a bigger subject, anchors differ, bad aspect falls back to square", () => {
  const size = (subjectScale: "s" | "m" | "l") => placeSubject(1.3, { subjectScale, anchor: "bottom", negativeSpace: "none" }).width;
  assert.ok(size("s") < size("m") && size("m") < size("l"));
  const bottom = placeSubject(1, DEFAULT_PLAN.composition), centre = placeSubject(1, { ...DEFAULT_PLAN.composition, anchor: "center" });
  assert.ok(bottom.y > centre.y, "a bottom-anchored subject sits lower");
  for (const bad of [0, -2, NaN, Infinity]) assert.deepEqual(placeSubject(bad, DEFAULT_PLAN.composition), placeSubject(1, DEFAULT_PLAN.composition), "aspect " + bad);
  assert.deepEqual(placeSubject(1.7, DEFAULT_PLAN.composition), placeSubject(1.7, DEFAULT_PLAN.composition), "deterministic");
});

/** width×height 的 RGBA，alpha 由函数给出。 */
function mask(width: number, height: number, visible: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = visible(x, y) ? 255 : 0;
  return data;
}
const blob = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r;

test("analyzeSubject and checkSubject follow the three documented rules", () => {
  const n = 100;
  const centred = analyzeSubject(mask(n, n, blob(50, 50, 28)), n, n);
  assert.ok(centred.areaRatio > 0.2 && centred.areaRatio < 0.3); assert.equal(centred.touchedEdges, 0); assert.equal(centred.largeBlobs, 1);
  assert.deepEqual(checkSubject(centred), [], "a normal product is not suspicious");

  assert.deepEqual(checkSubject(analyzeSubject(mask(n, n, () => false), n, n)), ["tiny"], "nothing found");
  assert.deepEqual(checkSubject(analyzeSubject(mask(n, n, (x, y) => x > 40 && x < 44 && y > 40 && y < 44), n, n)), ["tiny"], "under 2% of the image");
  assert.deepEqual(checkSubject(analyzeSubject(mask(n, n, () => true), n, n)).sort(), ["edges", "huge"], "the whole image is the subject");
  assert.ok(checkSubject(analyzeSubject(mask(n, n, (x, y) => !(x < 4 && y < 4)), n, n)).includes("huge"), "just under all of it, above 95%");

  const cut = analyzeSubject(mask(n, n, (x, y) => x < 60 && y > 20 && y < 70), n, n);
  assert.equal(cut.touchedEdges, 1); assert.deepEqual(checkSubject(cut), [], "touching one edge is allowed");
  const corner = analyzeSubject(mask(n, n, (x, y) => x < 40 && y > 55), n, n);
  assert.equal(corner.touchedEdges, 2); assert.ok(checkSubject(corner).includes("edges"), "touching two or more edges is suspicious");

  const blobs = (count: number) => (x: number, y: number) => Array.from({ length: count }, (_, i) => blob(15 + (i % 4) * 22, 25 + Math.floor(i / 4) * 40, 9)(x, y)).some(Boolean);
  assert.equal(analyzeSubject(mask(n, n, blobs(3)), n, n).largeBlobs, 3); assert.deepEqual(checkSubject(analyzeSubject(mask(n, n, blobs(3)), n, n)), [], "three blobs are allowed");
  assert.deepEqual(checkSubject(analyzeSubject(mask(n, n, blobs(4)), n, n)), ["fragmented"], "more than three blobs is suspicious");
  // 面积不到 1% 的小碎片不算连通块：一个商品加一点背景残留不会被判为“多个商品”。
  const specks = analyzeSubject(mask(n, n, (x, y) => blob(50, 50, 28)(x, y) || (x % 17 === 0 && y % 17 === 0 && x > 5 && y > 5 && x < 90 && y < 90)), n, n);
  assert.equal(specks.largeBlobs, 1);
  // 一个由对角线相连的商品是一个连通块（8 邻域），不会被拆成很多块。
  assert.equal(analyzeSubject(mask(n, n, (x, y) => Math.abs(x - y) <= 0 && x > 10 && x < 90), n, n).largeBlobs <= 1, true);
  assert.deepEqual(analyzeSubject(new Uint8ClampedArray(8), 10, 10), { areaRatio: 0, touchedEdges: 0, largeBlobs: 0 }, "short data does not read out of bounds");
  assert.equal(SUBJECT_LIMITS.maxBlobs, 3);
});

test("batchRequestFor submits only ready, non-excluded products with their own placements", () => {
  const entries = [entry(), entry({ excluded: true }), entry({ stage: "extracting", foregroundAssetId: undefined, bounds: undefined }), entry({ bounds: { x: 0, y: 0, width: 300, height: 900 } }), entry({ stage: "failed" })];
  assert.deepEqual(entries.map(included), [true, false, false, true, false]);
  const request = batchRequestFor(entries, DEFAULT_PLAN, id())!;
  assert.equal(request.kind, "batch"); assert.equal(request.version, 1); assert.equal(request.entries.length, 2);
  assert.deepEqual(request.entries.map(e => e.entryId), [entries[0].entryId, entries[3].entryId], "entry order follows the page");
  const [wide, tall] = request.entries;
  assert.equal(wide.sourceAssetId, entries[0].sourceAssetId); assert.equal(wide.foregroundAssetId, entries[0].foregroundAssetId); assert.equal(wide.documentId, entries[0].documentId);
  assert.equal(wide.scene, "marble"); assert.deepEqual(wide.canvas, { width: 1024, height: 1024, ratio: "1:1" }); assert.equal(wide.documentRevision, 1);
  assert.ok(serverAccepts(wide.placement, entryAspect(entries[0])) && serverAccepts(tall.placement, 3 / 9), "placements pass the server's rules");
  assert.ok(wide.placement.width > wide.placement.height && tall.placement.height > tall.placement.width, "each product keeps its own shape");
  assert.equal(batchRequestFor([entry({ excluded: true }), entry({ stage: "failed" })], DEFAULT_PLAN, id()), null, "an empty batch is never quoted");
  assert.equal(batchRequestFor([], DEFAULT_PLAN, id()), null);
  assert.equal(batchBudget(7, 2), 14);
  const planned = batchRequestFor([entries[0]], { scene: "wood", composition: { subjectScale: "l", anchor: "center", negativeSpace: "right" } }, id())!.entries[0];
  assert.equal(planned.scene, "wood"); assert.ok(planned.placement.x + planned.placement.width <= 0.65 + 1e-9, "the plan's negative space applies");
});

const item = (index: number, entryId: string, state: ServiceBatchItem["state"]): ServiceBatchItem => ({ index, entryId, attempt: 0, units: 2, state });
const view = (ids: string[], states: ServiceBatchItem["state"][], status: ServiceBatch["status"] = "running"): ServiceBatch => ({ groupId: id(), kind: "batch", entryIds: ids, count: ids.length,
  status, pauseReason: null, budgetUnits: ids.length * 2, unitUnits: 2, settledUnits: 0, heldUnits: 0, pricingVersion: "v1", createdAt: 0, items: ids.map((x, i) => item(i, x, states[i])) });

test("batch state helpers: counts, polling, stop, failed items and matching the local record", () => {
  const ids = Array.from({ length: 8 }, id), states: ServiceBatchItem["state"][] = ["succeeded", "succeeded", "failed", "leased", "queued", "waiting", "awaiting_credits", "cancelled"];
  const b = view(ids, states);
  assert.deepEqual(batchCounts(b), { done: 2, running: 1, queued: 1, waiting: 2, failed: 1, stopped: 1 });
  assert.equal(batchActive(b), true);
  assert.equal(batchActive(view(ids.slice(0, 2), ["succeeded", "failed"], "completed")), false, "nothing left to change");
  assert.equal(batchActive(view(ids.slice(0, 2), ["succeeded", "awaiting_credits"], "paused")), false, "a paused batch waits for the user");
  assert.equal(batchActive(view(ids.slice(0, 2), ["succeeded", "waiting"], "running")), true, "a running batch keeps polling for the next item");
  assert.equal(batchActive(view(ids.slice(0, 2), ["succeeded", "settling"], "paused")), true, "an item still settling keeps polling even when paused");
  assert.deepEqual(failedEntryIds(b), [ids[2]]);
  const request = { version: 1 as const, requestId: id(), kind: "batch" as const, entries: ids.map(entryId => ({ entryId, documentId: id(), documentRevision: 1, sourceAssetId: id(), foregroundAssetId: id(), scene: "marble" as const, canvas: { width: 1024 as const, height: 1024 as const, ratio: "1:1" as const }, placement: { x: .2, y: .2, width: .3, height: .3 } })) };
  assert.equal(batchMatches(b, { groupId: b.groupId, request }), true);
  assert.equal(batchMatches(b, { groupId: id(), request }), false, "another group");
  assert.equal(batchMatches(b, { groupId: b.groupId, request: { ...request, entries: request.entries.slice().reverse() } }), false, "different order");
  assert.equal(batchMatches(b, { groupId: b.groupId, request: { ...request, entries: request.entries.slice(1) } }), false, "different length");
  assert.equal(batchMatches({ ...b, items: b.items.map((x, i) => (i === 3 ? { ...x, entryId: id() } : x)) }, { groupId: b.groupId, request }), false, "an item for another entry");
  assert.equal(batchMatches({ ...b, items: b.items.map((x, i) => ({ ...x, index: 7 - i })) }, { groupId: b.groupId, request }), false, "items out of order");
});

test("zipName: <original>_<scene>_<ratio>.png, safe characters, duplicates get -2, -3 (case-insensitive)", () => {
  const used = new Set<string>();
  assert.equal(zipName("shoe-01.jpg", "marble", "1:1", used), "shoe-01_marble_1x1.png");
  assert.equal(zipName("shoe-01.png", "marble", "1:1", used), "shoe-01_marble_1x1-2.png", "same stem from another extension");
  assert.equal(zipName("SHOE-01.webp", "marble", "1:1", used), "SHOE-01_marble_1x1-3.png", "case-insensitive collision");
  assert.equal(zipName("a/b\\c:d*?.png", "wood", "3:4", used), "a_b_c_d__wood_3x4.png");
  assert.equal(zipName("  ..hidden.name.jpeg  ", "wood", "1:1", used), "hidden.name_wood_1x1.png");
  assert.equal(zipName("", "wood", "1:1", used), "image_wood_1x1.png"); assert.equal(zipName(".png", "wood", "1:1", used), "image_wood_1x1-2.png");
  assert.equal(zipName("拖鞋 蓝色.jpg", "geometry", "1:1", used), "拖鞋 蓝色_geometry_1x1.png", "non-ASCII names are kept");
  assert.ok(zipName("x".repeat(300) + ".png", "wood", "1:1", used).length <= 80 + "_wood_1x1.png".length);
  assert.ok(![...used].some(name => /[\\/:*?"<>|]/.test(name)), "no unsafe characters");
});

test("zipFiles produces a standard ZIP that unzips to the same bytes", async () => {
  const files = [{ name: "a_marble_1x1.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }, { name: "b_marble_1x1.png", data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256) }, { name: "empty.png", data: new Uint8Array(0) }];
  const chunks = await zipFiles(files), bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "starts with a local file header");
  const out = unzipSync(bytes);
  assert.deepEqual(Object.keys(out).sort(), files.map(f => f.name).sort());
  for (const f of files) assert.deepEqual(out[f.name], f.data, f.name);
  assert.ok(bytes.length < 5000 + 7 + 600, "stored, not inflated or duplicated");
  assert.equal((await zipFiles([])).length > 0, true, "an empty archive is still a valid archive");
});

const draft = (): BatchDraft => ({ version: 1, authUserId: id(), entries: [entry(), entry(), entry({ stage: "uploaded", foregroundAssetId: undefined, bounds: undefined }), entry({ stage: "extracting", foregroundAssetId: undefined, bounds: undefined,
  segment: { requestId: id(), quoteId: id(), jobId: id() } })], plan: structuredClone(DEFAULT_PLAN), groups: [] });

test("validBatchDraft accepts stored drafts and rejects corrupt ones", () => {
  const ok = draft();
  assert.ok(validBatchDraft(JSON.parse(JSON.stringify(ok))));
  const makeGroup = () => ({ groupId: id(), confirmed: true as const, request: batchRequestFor(ok.entries, ok.plan, id())! });
  const withGroup = { ...ok, groups: [makeGroup(), { ...makeGroup(), confirmed: undefined }] };
  assert.ok(validBatchDraft(JSON.parse(JSON.stringify(withGroup))));
  // 改动任意字段来模拟损坏的记录：这里需要无类型的 JSON 对象。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad = (change: (d: any) => void) => { const copy = JSON.parse(JSON.stringify(withGroup)); change(copy); return validBatchDraft(copy); };
  assert.equal(validBatchDraft(null), false); assert.equal(validBatchDraft({}), false); assert.equal(validBatchDraft("x"), false);
  assert.equal(bad(d => { d.version = 2; }), false);
  assert.equal(bad(d => { d.authUserId = 5; }), false);
  assert.equal(bad(d => { d.entries = Array.from({ length: MAX_BATCH_PRODUCTS + 1 }, () => entry()); }), false, "more than 20 products");
  assert.equal(bad(d => { d.entries[0].entryId = "x"; }), false);
  assert.equal(bad(d => { d.entries[1].entryId = d.entries[0].entryId; }), false, "duplicate entry ids");
  assert.equal(bad(d => { d.entries[0].stage = "uploading"; }), false, "an in-flight upload is never stored");
  assert.equal(bad(d => { d.entries[0].stage = "done"; }), false);
  assert.equal(bad(d => { d.entries[0].excluded = "no"; }), false);
  assert.equal(bad(d => { d.entries[0].fileName = "x".repeat(300); }), false);
  assert.equal(bad(d => { d.entries[0].sourceAssetId = "x"; }), false);
  assert.equal(bad(d => { delete d.entries[0].foregroundAssetId; }), false, "a ready entry needs its foreground");
  assert.equal(bad(d => { d.entries[0].bounds.width = 0; }), false);
  assert.equal(bad(d => { d.entries[0].bounds = "x"; }), false);
  assert.equal(bad(d => { d.entries[3].segment.quoteId = "x"; }), false);
  assert.equal(bad(d => { d.entries[0].check = { reasons: ["weird"], metrics: { areaRatio: 0.1, touchedEdges: 0, largeBlobs: 1 } }; }), false);
  assert.equal(bad(d => { d.plan.scene = "beach"; }), false);
  assert.equal(bad(d => { d.plan.composition.subjectScale = "xl"; }), false);
  assert.equal(bad(d => { d.plan.composition.negativeSpace = "bottom"; }), false);
  assert.equal(bad(d => { d.groups[0].groupId = "x"; }), false);
  assert.equal(bad(d => { d.groups[0].confirmed = false; }), false);
  assert.equal(bad(d => { d.groups[0].request.kind = "candidates"; }), false);
  assert.equal(bad(d => { d.groups[0].request.entries = []; }), false);
  assert.equal(bad(d => { d.groups[0].request.entries[0].placement.x = NaN; }), false);
  assert.equal(bad(d => { d.groups[0].request.entries[0].scene = "beach"; }), false);
  assert.equal(bad(d => { d.groups[0].request.entries[1].entryId = d.groups[0].request.entries[0].entryId; }), false);
  assert.equal(bad(d => { d.groups[1].groupId = d.groups[0].groupId; }), false, "duplicate group ids");
  assert.equal(bad(d => { d.groups = Array.from({ length: 6 }, () => makeGroup()); }), false, "more than five remembered batches");
  assert.equal(bad(d => { delete d.groups; }), false, "groups are required");
});

test("entryOutcome: a success in any batch is kept, otherwise the newest batch decides", () => {
  const [a, b, c] = [id(), id(), id()];
  const first = view([a, b, c], ["succeeded", "failed", "failed"], "completed"), redo = view([b], ["succeeded"], "completed"), redoAgain = view([c], ["cancelled"], "cancelled");
  const groups = [{ groupId: first.groupId }, { groupId: redo.groupId }, { groupId: redoAgain.groupId }];
  const views = { [first.groupId]: first, [redo.groupId]: redo, [redoAgain.groupId]: redoAgain };
  assert.equal(entryOutcome(a, groups, views)?.groupId, first.groupId, "a success in the first batch stays");
  assert.equal(entryOutcome(b, groups, views)?.groupId, redo.groupId, "the redo succeeded and replaces the failure");
  assert.equal(entryOutcome(b, groups, views)?.item.state, "succeeded");
  assert.equal(entryOutcome(c, groups, views)?.groupId, redoAgain.groupId, "no success anywhere: the newest batch decides");
  assert.equal(entryOutcome(c, groups, views)?.item.state, "cancelled");
  assert.equal(entryOutcome(id(), groups, views), undefined, "an entry that was never submitted");
  assert.equal(entryOutcome(a, groups, {}), undefined, "views that have not loaded yet");
  // 成功之后的重做不能把成功盖掉：第二个批次里同一件商品失败了，仍然显示第一个批次的成功。
  const failedRedo = view([a], ["failed"], "completed");
  assert.equal(entryOutcome(a, [...groups, { groupId: failedRedo.groupId }], { ...views, [failedRedo.groupId]: failedRedo })?.item.state, "succeeded");
});

// ── 我的批次（服务端列表） ───────────────────────────────────────────────────────────────────────
const summary = (patch: Partial<ServiceGroupSummary> = {}): ServiceGroupSummary => ({
  groupId: id(), kind: "batch", status: "running", pauseReason: null, count: 5, unitUnits: 2, budgetUnits: 10, settledUnits: 2, heldUnits: 4, pricingVersion: "v1",
  counts: { succeeded: 1, running: 2, failed: 0, cancelled: 0, waiting: 2 }, createdAt: 1_700_000_000_000, confirmedAt: 1_700_000_001_000, finishedAt: null, ...patch,
});

test("validGroupSummaries: keeps well-formed batch rows in order and drops anything the page cannot trust", () => {
  const a = summary(), b = summary({ status: "completed", counts: { succeeded: 5, running: 0, failed: 0, cancelled: 0, waiting: 0 }, finishedAt: 1_700_000_900_000 });
  assert.deepEqual(validGroupSummaries({ groups: [a, b] }).map(row => row.groupId), [a.groupId, b.groupId]);
  assert.deepEqual(validGroupSummaries({ groups: [] }), []);
  for (const bad of [null, undefined, {}, { groups: "x" }, { groups: null }, []]) assert.deepEqual(validGroupSummaries(bad), []);
  const broken: Partial<ServiceGroupSummary>[] = [
    { kind: "candidates" }, { groupId: "nope" }, { status: "quoted" as never }, { status: "weird" as never }, { count: 0 }, { count: 61 }, { count: 2.5 },
    { budgetUnits: -1 }, { settledUnits: NaN }, { heldUnits: "4" as never }, { createdAt: Infinity }, { pauseReason: "other" as never },
    { counts: { succeeded: 1, running: 2, failed: 0, cancelled: 0, waiting: 1 } },                 // 加起来 4 ≠ 5：对不上的进度不显示
    { counts: { succeeded: 1, running: 2, failed: 0, cancelled: 0 } as never }, { counts: undefined as never }, { counts: { succeeded: -1, running: 3, failed: 0, cancelled: 0, waiting: 3 } },
  ];
  for (const patch of broken) assert.deepEqual(validGroupSummaries({ groups: [a, summary(patch)] }).map(row => row.groupId), [a.groupId], JSON.stringify(patch));
  assert.deepEqual(validGroupSummaries({ groups: [a, null, 7, "x", { ...a }] }).map(row => row.groupId), [a.groupId], "non-objects are dropped and a repeated groupId keeps the first row");
  assert.equal(validGroupSummaries({ groups: [summary({ status: "paused", pauseReason: "insufficient_credits" })] }).length, 1);
});

test("summaryActive and summaryIsLocal: only a running group refreshes by itself; local groups are marked", () => {
  assert.equal(summaryActive(summary({ status: "running" })), true);
  for (const status of ["paused", "completed", "cancelled"] as const) assert.equal(summaryActive(summary({ status })), false, status);
  const row = summary();
  assert.equal(summaryIsLocal(row, [{ groupId: id() }, { groupId: row.groupId }]), true);
  assert.equal(summaryIsLocal(row, [{ groupId: id() }]), false);
  assert.equal(summaryIsLocal(row, []), false);
});

test("remoteBatchValid: the view must be the opened batch and agree with itself; remote ZIP names follow the local scheme", () => {
  const groupId = id(), entryIds = [id(), id(), id()];
  const view = (patch: Partial<ServiceBatch> = {}): ServiceBatch => ({
    groupId, kind: "batch", entryIds, count: 3, status: "running", pauseReason: null, budgetUnits: 6, unitUnits: 2, settledUnits: 0, heldUnits: 0, pricingVersion: "v1", createdAt: 1,
    items: entryIds.map((entryId, index) => ({ index, entryId, attempt: 0, units: 2, state: "waiting" as const })), ...patch });
  assert.equal(remoteBatchValid(view(), groupId), true);
  assert.equal(remoteBatchValid(view(), id()), false, "another batch than the one that was opened");
  assert.equal(remoteBatchValid(view({ kind: "candidates" as never }), groupId), false);
  assert.equal(remoteBatchValid(view({ count: 4 }), groupId), false);
  assert.equal(remoteBatchValid(view({ entryIds: entryIds.slice(0, 2) }), groupId), false);
  assert.equal(remoteBatchValid(view({ items: view().items.slice().reverse() }), groupId), false, "items out of order");
  assert.equal(remoteBatchValid(view({ items: undefined as never }), groupId), false);
  const used = new Set<string>();
  assert.equal(remoteZipName(0, "wood", used), "product-01_wood_1x1.png");
  assert.equal(remoteZipName(11, "marble", used), "product-12_marble_1x1.png");
  assert.equal(remoteZipName(0, "wood", used), "product-01_wood_1x1-2.png", "same name twice is de-duplicated");
  assert.equal(remoteZipName(2, undefined, new Set()), "product-03_scene_1x1.png", "an item without a scene still gets a valid name");
});
