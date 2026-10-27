/**
 * 批量场景的纯函数部分：主体检查、自动放置、请求构造、状态汇总、ZIP 命名与打包、本地记录校验。
 * 没有任何浏览器 API，可以在 Node 里直接测试。
 *
 * 产品规则见私有仓库 docs/product-workbench-modules-design.md §4：
 * 先提取主体并让用户检查，再确认积分；构图由前后端共用的确定性函数算出，不靠各自估算。
 */
import { Zip, ZipPassThrough } from "fflate";
import type { Rect, SceneId } from "./contracts";
import type { ServiceBatch, ServiceBatchEntry, ServiceBatchItem, ServiceBatchRequest, ServiceGroupItemState } from "./service-contracts";

export const MAX_BATCH_PRODUCTS = 20;
export const SCENES: readonly SceneId[] = ["marble", "wood", "geometry"];
export const CANVAS = { width: 1024, height: 1024, ratio: "1:1" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ───────────────────────── 主体检查（设计 §4.3） ─────────────────────────

/** 主体检查的三个指标，都由浏览器读取前景的 Alpha 得到，不需要 GPU。 */
export interface SubjectMetrics { areaRatio: number; touchedEdges: number; largeBlobs: number }
/** tiny/huge：可能没识别到商品或把背景当成了主体；edges：商品可能被裁掉一部分；fragmented：可能有多个商品或背景残留。 */
export type SubjectReason = "tiny" | "huge" | "edges" | "fragmented";
export const SUBJECT_LIMITS = { minArea: 0.02, maxArea: 0.95, touchedEdges: 2, blobArea: 0.01, maxBlobs: 3, visibleAlpha: 128, edgeFraction: 0.004 } as const;

/**
 * 读取前景 RGBA 像素（调用方先缩小到长边约 256，保证快）：可见（alpha ≥ 128）面积占比、
 * 可见包围盒接触了几条图像边、面积超过 1% 的连通块个数（8 邻域）。
 */
export function analyzeSubject(data: Uint8ClampedArray, width: number, height: number): SubjectMetrics {
  const total = width * height;
  if (total <= 0 || data.length < total * 4) return { areaRatio: 0, touchedEdges: 0, largeBlobs: 0 };
  const visible = new Uint8Array(total);
  let area = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] < SUBJECT_LIMITS.visibleAlpha) continue;
    visible[i] = 1; area++;
    const x = i % width, y = (i / width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (area === 0) return { areaRatio: 0, touchedEdges: 0, largeBlobs: 0 };
  const edge = Math.max(1, Math.round(Math.max(width, height) * SUBJECT_LIMITS.edgeFraction));
  const touchedEdges = Number(minX < edge) + Number(minY < edge) + Number(maxX >= width - edge) + Number(maxY >= height - edge);
  // 迭代式泛洪（不用递归，避免大块区域爆栈）。
  const seen = new Uint8Array(total), stack = new Int32Array(total);
  let largeBlobs = 0;
  for (let start = 0; start < total; start++) {
    if (!visible[start] || seen[start]) continue;
    let size = 0, top = 0;
    stack[top++] = start; seen[start] = 1;
    while (top > 0) {
      const at = stack[--top]; size++;
      const x = at % width, y = (at / width) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (visible[next] && !seen[next]) { seen[next] = 1; stack[top++] = next; }
      }
    }
    if (size / total > SUBJECT_LIMITS.blobArea) largeBlobs++;
  }
  return { areaRatio: area / total, touchedEdges, largeBlobs };
}
/** 命中任何一条就标为“可疑”，但**不会自动排除**：由用户决定排除、替换原图还是照用。 */
export function checkSubject(metrics: SubjectMetrics): SubjectReason[] {
  const reasons: SubjectReason[] = [];
  if (metrics.areaRatio < SUBJECT_LIMITS.minArea) reasons.push("tiny");
  if (metrics.areaRatio > SUBJECT_LIMITS.maxArea) reasons.push("huge");
  if (metrics.touchedEdges >= SUBJECT_LIMITS.touchedEdges) reasons.push("edges");
  if (metrics.largeBlobs > SUBJECT_LIMITS.maxBlobs) reasons.push("fragmented");
  return reasons;
}

// ───────────────────────── 方案与自动放置（设计 §4.4） ─────────────────────────

/** 构图规则：整批共享。 */
export interface CompositionRule {
  /** 主体可见包围盒占可用区域短边的比例：s/m/l = 0.45 / 0.60 / 0.75（初始值，用样张校准）。 */
  subjectScale: "s" | "m" | "l";
  /** bottom：商品底边距画布底部 8%，模拟放在台面上；center：在可用区域内居中。 */
  anchor: "bottom" | "center";
  /** 文字留白：从对应方向划出 35% 不放商品。 */
  negativeSpace: "none" | "left" | "right" | "top";
}
export interface BatchPlan { scene: SceneId; composition: CompositionRule }
export const DEFAULT_PLAN: BatchPlan = { scene: "marble", composition: { subjectScale: "m", anchor: "bottom", negativeSpace: "none" } };
export const SCALE_FACTOR = { s: 0.45, m: 0.6, l: 0.75 } as const;
const MARGIN = 0.02, BOTTOM_GAP = 0.08, NEGATIVE_SPACE = 0.35;

/**
 * 确定性的放置函数。aspect 是主体可见包围盒的宽高比（服务端给出的 bounds）。步骤：
 * 1. 画布减去留白区和 2% 边距，得到可用区域；
 * 2. 在“可用区域短边 × subjectScale”的方框里等比放入主体；
 * 3. 按 anchor 确定位置，并约束在可用区域内；
 * 4. 换算成归一化坐标。**x、宽度相对画布宽度，y、高度相对画布高度**，所以保持比例的条件是 width·W / (height·H) = aspect。
 */
export function placeSubject(aspect: number, rule: CompositionRule, canvas: { width: number; height: number } = CANVAS): Rect {
  const W = canvas.width, H = canvas.height, a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let x0 = MARGIN, y0 = MARGIN, x1 = 1 - MARGIN;
  const y1 = 1 - MARGIN;
  if (rule.negativeSpace === "left") x0 = NEGATIVE_SPACE;
  else if (rule.negativeSpace === "right") x1 = 1 - NEGATIVE_SPACE;
  else if (rule.negativeSpace === "top") y0 = NEGATIVE_SPACE;
  const ux = x0 * W, uy = y0 * H, uw = (x1 - x0) * W, uh = (y1 - y0) * H;
  const limit = Math.min(uw, uh) * SCALE_FACTOR[rule.subjectScale];
  let width = a >= 1 ? limit : limit * a, height = width / a;
  const fit = Math.min(1, uw / width, uh / height);
  width *= fit; height *= fit;
  const left = ux + (uw - width) / 2;
  const top = rule.anchor === "bottom" ? Math.min(Math.max((1 - BOTTOM_GAP) * H - height, uy), uy + uh - height) : uy + (uh - height) / 2;
  return { x: left / W, y: top / H, width: width / W, height: height / H };
}

// ───────────────────────── 批量条目与请求 ─────────────────────────

/** 一件商品在批量页里的状态。uploading 只存在于内存（文件刷新后就没了），不会被保存。 */
export type EntryStage = "uploading" | "uploaded" | "extracting" | "ready" | "failed";
export interface BatchEntryRecord {
  entryId: string; documentId: string; fileName: string; stage: EntryStage;
  sourceAssetId?: string;
  /** 提取主体的任务。刷新后用它继续查询，不会重复提交。 */
  segment?: { requestId: string; quoteId: string; jobId?: string };
  foregroundAssetId?: string;
  /** 前景可见包围盒（原图像素），来自服务端；放置的宽高比以它为准。 */
  bounds?: Rect;
  check?: { reasons: SubjectReason[]; metrics: SubjectMetrics };
  excluded: boolean;
  error?: string;
}
/** 可以进入批次的商品：主体已提取好，且用户没有排除。 */
export const included = (entry: BatchEntryRecord) => entry.stage === "ready" && !entry.excluded && !!entry.sourceAssetId && !!entry.foregroundAssetId && !!entry.bounds;
export const entryAspect = (entry: BatchEntryRecord) => (entry.bounds && entry.bounds.height > 0 ? entry.bounds.width / entry.bounds.height : 1);
/** 每件商品用整批的方案算出放置。用户单张微调（以后）只会覆盖其中一项。 */
export const entryPlacement = (entry: BatchEntryRecord, plan: BatchPlan): Rect => placeSubject(entryAspect(entry), plan.composition);

/** 由已就绪的商品和方案构造批量请求；没有可提交的商品时返回 null（空批次前端直接拒绝，不产生报价）。 */
export function batchRequestFor(entries: readonly BatchEntryRecord[], plan: BatchPlan, requestId: string): ServiceBatchRequest | null {
  const chosen = entries.filter(included);
  if (chosen.length === 0) return null;
  return { version: 1, requestId, kind: "batch", entries: chosen.map((entry): ServiceBatchEntry => ({
    entryId: entry.entryId, documentId: entry.documentId, documentRevision: 1, sourceAssetId: entry.sourceAssetId!, foregroundAssetId: entry.foregroundAssetId!,
    scene: plan.scene, canvas: { ...CANVAS }, placement: entryPlacement(entry, plan) })) };
}
/** 预算 = 提交的项数 × 单价（与服务端的计算相同；服务端的报价为准）。 */
export const batchBudget = (itemCount: number, unitUnits: number) => itemCount * unitUnits;

// ───────────────────────── 状态汇总 ─────────────────────────

const IN_PROGRESS: ServiceGroupItemState[] = ["queued", "leased", "verifying", "settling"];
const TERMINAL: ServiceGroupItemState[] = ["succeeded", "failed", "cancelled"];
export interface BatchCounts { done: number; running: number; queued: number; waiting: number; failed: number; stopped: number }
export function batchCounts(batch: Pick<ServiceBatch, "items">): BatchCounts {
  const count = (states: ServiceGroupItemState[]) => batch.items.filter(item => states.includes(item.state)).length;
  return { done: count(["succeeded"]), running: count(["leased", "verifying", "settling"]), queued: count(["queued"]), waiting: count(["waiting", "awaiting_credits"]), failed: count(["failed"]), stopped: count(["cancelled"]) };
}
/** 批次是否还会自己变化（决定要不要继续轮询）：有执行中的项，或批次在运行且还有没结束的项。暂停（等待积分）要等用户补充后继续。 */
export function batchActive(batch: Pick<ServiceBatch, "items" | "status">): boolean {
  if (batch.items.some(item => IN_PROGRESS.includes(item.state))) return true;
  return batch.status === "running" && batch.items.some(item => !TERMINAL.includes(item.state));
}
export const batchStoppable = (batch: Pick<ServiceBatch, "status">) => batch.status === "running" || batch.status === "paused";
/** 一件商品当前的结果：来自哪个批次的哪一项。 */
export interface EntryOutcome { groupId: string; item: ServiceBatchItem }
/**
 * 一件商品在页面上显示哪个批次的结果。重新生成失败项会新增一个批次，所以同一件商品可能出现在几个批次里：
 * 任何批次里成功过的优先（成功项保留，不会被后来的失败或取消盖掉）；没有成功过就取最新批次里的那一项。
 */
export function entryOutcome(entryId: string, groups: readonly { groupId: string }[], views: Readonly<Record<string, ServiceBatch | undefined>>): EntryOutcome | undefined {
  let latest: EntryOutcome | undefined;
  for (let i = groups.length - 1; i >= 0; i--) {
    const view = views[groups[i].groupId], item = view?.items.find(candidate => candidate.entryId === entryId);
    if (!item) continue;
    if (item.state === "succeeded") return { groupId: groups[i].groupId, item };
    latest ??= { groupId: groups[i].groupId, item };
  }
  return latest;
}
/** 失败的项可以重新生成：用这几项再提交一个新批次（新的 requestId、新的报价）。 */
export const failedEntryIds = (batch: Pick<ServiceBatch, "items">) => batch.items.filter(item => item.state === "failed" && item.entryId).map(item => item.entryId);
/** 服务端返回的批次必须对应本地记录的那次确认：同一个 groupId，同样的商品顺序。 */
export function batchMatches(batch: ServiceBatch, record: { groupId: string; request: ServiceBatchRequest }): boolean {
  const ids = record.request.entries.map(entry => entry.entryId);
  return batch.groupId === record.groupId && batch.kind === "batch" && batch.count === ids.length && Array.isArray(batch.entryIds) &&
    batch.entryIds.length === ids.length && batch.entryIds.every((id, index) => id === ids[index]) &&
    Array.isArray(batch.items) && batch.items.length === ids.length && batch.items.every((item, index) => item.index === index && item.entryId === ids[index]);
}

// ───────────────────────── ZIP ─────────────────────────

/**
 * ZIP 里的文件名：`<原文件名>_<场景>_<画幅>.png`，重名（不分大小写，Windows 解压时会冲突）加 -2、-3。
 * 画幅里的冒号换成 x（"1:1" → "1x1"），路径分隔符和控制字符去掉，过长的原文件名截断。
 */
export function zipName(fileName: string, scene: string, ratio: string, used: Set<string>): string {
  const stem = fileName.replace(/\.[^./\\]*$/, "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || "image";
  const base = `${stem}_${scene}_${ratio.replace(":", "x")}`;
  let name = `${base}.png`, n = 1;
  while (used.has(name.toLowerCase())) name = `${base}-${++n}.png`;
  used.add(name.toLowerCase());
  return name;
}
/**
 * 把文件打成 ZIP，返回分块的字节。PNG 已经压缩过，所以只存储不再压缩（level 0）。
 * 用 fflate 的流式接口：一个文件一个文件地写入，调用方可以把分块直接交给 Blob，不需要在内存里拼成一整块。
 */
export function zipFiles(files: readonly { name: string; data: Uint8Array }[]): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [], zip = new Zip((error, chunk, final) => {
      if (error) { reject(error); return; }
      chunks.push(chunk);
      if (final) resolve(chunks);
    });
    try {
      for (const file of files) { const entry = new ZipPassThrough(file.name); zip.add(entry); entry.push(file.data, true); }
      zip.end();
    } catch (error) { reject(error); }
  });
}

// ───────────────────────── 本地记录校验 ─────────────────────────

/** 一次确认的批次。刷新后用 groupId 继续查询；确认请求可以安全重发（服务端按 groupId + 请求内容幂等）。 */
export interface BatchGroupRecord { groupId: string; request: ServiceBatchRequest; confirmed?: true }
/** 页面最多同时记住的批次数：第一批加几次“重新生成失败项”。 */
export const MAX_BATCH_GROUPS = 5;
export interface BatchDraft {
  version: 1; authUserId: string; entries: BatchEntryRecord[]; plan: BatchPlan;
  /** 按时间从早到晚。重新生成失败项会新增一个批次，旧批次里成功的项保留。 */
  groups: BatchGroupRecord[];
}
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validRect = (r: unknown): r is Rect => !!r && typeof r === "object" && ["x", "y", "width", "height"].every(k => num((r as Record<string, unknown>)[k]));
const validEntryRequest = (e: ServiceBatchEntry) => !!e && UUID.test(e.entryId) && UUID.test(e.documentId) && Number.isSafeInteger(e.documentRevision) && UUID.test(e.sourceAssetId) &&
  UUID.test(e.foregroundAssetId) && SCENES.includes(e.scene) && e.canvas?.width === 1024 && e.canvas?.height === 1024 && e.canvas?.ratio === "1:1" && validRect(e.placement);
function validEntry(e: BatchEntryRecord): boolean {
  if (!e || !UUID.test(e.entryId) || !UUID.test(e.documentId) || typeof e.fileName !== "string" || e.fileName.length > 255 || typeof e.excluded !== "boolean") return false;
  if (!["uploaded", "extracting", "ready", "failed"].includes(e.stage)) return false; // uploading 不会被保存
  if (e.sourceAssetId !== undefined && !UUID.test(e.sourceAssetId)) return false;
  if (e.foregroundAssetId !== undefined && !UUID.test(e.foregroundAssetId)) return false;
  if (e.bounds !== undefined && !(validRect(e.bounds) && e.bounds.width > 0 && e.bounds.height > 0)) return false;
  if (e.error !== undefined && (typeof e.error !== "string" || e.error.length > 64)) return false;
  if (e.segment !== undefined && !(UUID.test(e.segment.requestId) && UUID.test(e.segment.quoteId) && (e.segment.jobId === undefined || UUID.test(e.segment.jobId)))) return false;
  if (e.check !== undefined && !(Array.isArray(e.check.reasons) && e.check.reasons.every(r => ["tiny", "huge", "edges", "fragmented"].includes(r)) &&
    e.check.metrics && [e.check.metrics.areaRatio, e.check.metrics.touchedEdges, e.check.metrics.largeBlobs].every(num))) return false;
  // 就绪的商品必须有源图、前景和包围盒，否则不能进入请求。
  return e.stage !== "ready" || (!!e.sourceAssetId && !!e.foregroundAssetId && !!e.bounds);
}
/** 刷新后从本地读回的记录必须先过校验，损坏的记录不会变成服务请求。 */
export function validBatchDraft(value: unknown): value is BatchDraft {
  const d = value as BatchDraft;
  if (!d || typeof d !== "object" || d.version !== 1 || typeof d.authUserId !== "string" || !Array.isArray(d.entries) || d.entries.length > MAX_BATCH_PRODUCTS) return false;
  if (!d.entries.every(validEntry) || new Set(d.entries.map(e => e.entryId)).size !== d.entries.length) return false;
  const plan = d.plan, rule = plan?.composition;
  if (!plan || !SCENES.includes(plan.scene) || !rule || !["s", "m", "l"].includes(rule.subjectScale) || !["bottom", "center"].includes(rule.anchor) ||
    !["none", "left", "right", "top"].includes(rule.negativeSpace)) return false;
  if (!Array.isArray(d.groups) || d.groups.length > MAX_BATCH_GROUPS || new Set(d.groups.map(g => g?.groupId)).size !== d.groups.length) return false;
  return d.groups.every(g => {
    const r = g?.request;
    return UUID.test(g.groupId) && (g.confirmed === undefined || g.confirmed === true) && !!r && r.version === 1 && r.kind === "batch" && UUID.test(r.requestId) &&
      Array.isArray(r.entries) && r.entries.length >= 1 && r.entries.length <= 60 && r.entries.every(validEntryRequest) && new Set(r.entries.map(e => e.entryId)).size === r.entries.length;
  });
}
