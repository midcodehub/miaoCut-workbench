// 单张场景任务在页面上怎么读网关的状态。
//
// 网关（miaoCut-pro pro-gateway comfy.js / gpu-registry comfy-core createJob）创建任务时不看 GPU 心跳。
// capabilities.execution 只表示“现在有没有一台机器在报心跳”。冷启动时心跳是 false，任务仍然可以入队，
// 调度器看到队列里有任务才会去拉节点（miaoCut-pro PR 38）。所以这里绝不能因为 workerOnline === false 就停。
//
// 积分订单在服务端 30 分钟过期（comfy_orders.expires_at），过期后状态变成 failed / job_expired，预留退回。
// 页面在那之前一直查；超过 35 分钟还没结束就改成“仍在查询、但不再转圈”，避免一直接着转。
import type { SceneId } from "./contracts";
import type { SceneHistoryEntry, ServiceJob } from "./service-contracts";
import { validServiceDocument } from "./service-state";

export const SCENE_POLL_MS = 2_000;
export const SCENE_POLL_BACKOFF_MAX_MS = 15_000;
export const SCENE_CLIENT_DEADLINE_MS = 35 * 60 * 1000;
/** 成功响应偶尔先到、结果图还没挂上。再问几次，然后交给历史列表慢慢补，不要把转圈停在“正在生成”。 */
export const SCENE_OUTPUT_GRACE = 4;
export const SCENE_HISTORY_LIMIT = 20;
const SLOW_POLL_MS = 15_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCENES = new Set(["marble", "wood", "geometry"]);
const JOB_STATES = new Set(["queued", "leased", "verifying", "settling", "succeeded", "failed", "cancelled"]);
const BILLING = new Set(["held", "confirmed", "released", "unbilled"]);
const ACTIVE = new Set(["queued", "leased", "verifying", "settling"]);

export type ScenePhase =
  | "starting" | "queued" | "running" | "verifying" | "settling" | "reconnecting"
  | "succeeded" | "failed" | "refunded" | "cancelled" | "expired" | "timeout" | "missing_output";

export interface ScenePollStep {
  phase: ScenePhase;
  /** 还要不要继续 GET /jobs/:id。false 表示这一单在页面上可以收尾了。 */
  poll: boolean;
  delayMs: number;
  resultAssetId?: string;
}

export interface ScenePollInput {
  job: Pick<ServiceJob, "state" | "error" | "queue" | "billing" | "outputs">;
  kind: "segment" | "product";
  startedAt: number;
  now: number;
  /** 这次之前，已经连续看到几次“成功但没有该有的结果图”。 */
  missingOutputs: number;
}

/**
 * 冷节点也可以提交。唯一会挡住新任务的是网关自己的接单开关（admissionOpen === false → billing_paused）。
 * execution.status 不在这个判断里：它只是心跳，不是准入。
 */
export function sceneSubmitAllowed(admissionOpen: boolean | undefined): boolean {
  return admissionOpen !== false;
}

export function pollBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(SCENE_POLL_BACKOFF_MAX_MS, SCENE_POLL_MS * 2 ** Math.min(n - 1, 3));
}

function releasedPaid(job: ScenePollInput["job"]): boolean {
  return job.billing?.mode === "credits_internal" && job.billing.state === "released" && job.billing.units > 0;
}

function expectedAssetId(job: ScenePollInput["job"], kind: ScenePollInput["kind"]): string | undefined {
  const asset = kind === "segment" ? job.outputs?.foreground : job.outputs?.final;
  return asset && UUID.test(asset.assetId) ? asset.assetId : undefined;
}

/** 把一次 GET /jobs/:id 译成页面该显示什么、还要不要再问。纯函数，不发请求。 */
export function scenePollStep(input: ScenePollInput): ScenePollStep {
  const { job, kind, startedAt, now, missingOutputs } = input;
  const assetId = expectedAssetId(job, kind);
  if (job.state === "succeeded" && assetId) return { phase: "succeeded", poll: false, delayMs: 0, resultAssetId: assetId };
  if (job.state === "succeeded") {
    if (missingOutputs + 1 >= SCENE_OUTPUT_GRACE) return { phase: "missing_output", poll: false, delayMs: 0 };
    return { phase: "settling", poll: true, delayMs: SCENE_POLL_MS };
  }
  if (job.state === "failed") {
    if (job.error === "job_expired") return { phase: "expired", poll: false, delayMs: 0 };
    return { phase: releasedPaid(job) ? "refunded" : "failed", poll: false, delayMs: 0 };
  }
  if (job.state === "cancelled") return { phase: releasedPaid(job) ? "refunded" : "cancelled", poll: false, delayMs: 0 };
  if (ACTIVE.has(job.state) && Number.isFinite(startedAt) && now - startedAt >= SCENE_CLIENT_DEADLINE_MS) {
    return { phase: "timeout", poll: true, delayMs: SLOW_POLL_MS };
  }
  if (job.state === "queued" && job.queue?.workerOnline === false) return { phase: "starting", poll: true, delayMs: SCENE_POLL_MS };
  if (job.state === "queued") return { phase: "queued", poll: true, delayMs: SCENE_POLL_MS };
  if (job.state === "verifying") return { phase: "verifying", poll: true, delayMs: SCENE_POLL_MS };
  if (job.state === "settling") return { phase: "settling", poll: true, delayMs: SCENE_POLL_MS };
  return { phase: "running", poll: true, delayMs: SCENE_POLL_MS };
}

const CREATE_REJECT = new Set([
  "invalid_fields", "invalid_placement", "aspect_ratio_changed", "invalid_pixel_placement", "unsupported_canvas", "invalid_product",
  "quote_expired", "quote_changed", "insufficient", "billing_paused", "invalid_quote", "too_many_active_jobs",
]);

/**
 * 查询中途的错误该停还是再试。网络抖动、5xx 再试——以前一出错就停，任务在服务端完成后页面要手动刷新才看得到。
 * 登录失效、资产作废、创建请求本身被拒，不再试。
 */
export function scenePollErrorAction(error: { code?: string; status?: number } | null, hasJobId: boolean): "expired_asset" | "reject" | "retry" {
  const code = error?.code || "";
  const status = error?.status ?? 0;
  if (code === "asset_not_found" || code === "asset_expired" || code === "foreground_lineage") return "expired_asset";
  if (status === 401 || status === 403 || code === "job_not_found") return "reject";
  if (!hasJobId && CREATE_REJECT.has(code)) return "reject";
  return "retry";
}

export type CreditPhrase = "free" | "charged" | "refunded" | "reserved";

/** 这一行该说“已扣 / 已退回 / 已预留 / 未扣”。0 积分（主体提取，或未计费）一律是未扣。 */
export function creditPhrase(row: Pick<SceneHistoryEntry, "billing" | "units">): CreditPhrase {
  if (row.billing === "unbilled" || !(row.units > 0)) return "free";
  if (row.billing === "confirmed") return "charged";
  if (row.billing === "released") return "refunded";
  return "reserved";
}

export function historyFromJob(job: Pick<ServiceJob, "jobId" | "state" | "error" | "billing" | "outputs" | "request">, createdAt: number): SceneHistoryEntry | null {
  const request = job.request;
  const scene = request.scene;
  const document = request.kind === "product" && request.foregroundAssetId && request.canvas && request.placement && scene
    ? { id: request.documentId, revision: request.documentRevision, sourceAssetId: request.sourceAssetId,
      foregroundAssetId: request.foregroundAssetId, scene, canvas: request.canvas, placement: request.placement }
    : null;
  if (!document || !scene || !SCENES.has(scene)) return null;
  const paid = job.billing?.mode === "credits_internal" ? job.billing : null;
  const resultAssetId = job.state === "succeeded" && job.outputs?.final && UUID.test(job.outputs.final.assetId) ? job.outputs.final.assetId : undefined;
  return { jobId: job.jobId, scene: scene as SceneId, createdAt, units: paid ? paid.units : 0, billing: paid ? paid.state : "unbilled",
    state: job.state, error: job.error, ...(resultAssetId ? { resultAssetId } : {}), document };
}

function validEntry(value: unknown): SceneHistoryEntry | null {
  const row = value as SceneHistoryEntry;
  if (!row || !UUID.test(row.jobId || "") || !SCENES.has(row.scene) || !Number.isFinite(row.createdAt) || !Number.isSafeInteger(row.units) || row.units < 0) return null;
  if (!BILLING.has(row.billing) || !JOB_STATES.has(row.state) || (row.error !== null && typeof row.error !== "string")) return null;
  if (row.resultAssetId !== undefined && !UUID.test(row.resultAssetId)) return null;
  if (!validServiceDocument(row.document) || row.document.scene !== row.scene) return null;
  return { jobId: row.jobId, scene: row.scene, createdAt: row.createdAt, units: row.units, billing: row.billing, state: row.state,
    error: row.error, ...(row.resultAssetId ? { resultAssetId: row.resultAssetId } : {}), document: row.document };
}

/** 丢掉坏行、按创建时间新的在前、同一 jobId 只留一条、最多 20 条。 */
export function sceneHistory(value: unknown): SceneHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, SceneHistoryEntry>();
  for (const row of value) {
    const entry = validEntry(row);
    if (entry && !byId.has(entry.jobId)) byId.set(entry.jobId, entry);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, SCENE_HISTORY_LIMIT);
}

export function rememberSceneJob(history: unknown, entry: SceneHistoryEntry): SceneHistoryEntry[] {
  const clean = validEntry(entry);
  if (!clean) return sceneHistory(history);
  return sceneHistory([clean, ...sceneHistory(history).filter(row => row.jobId !== clean.jobId)]);
}

/** 历史列表里还要不要自己去问服务端。当前正在跟踪的那张由主轮询负责，调用方把它排除。 */
export function historyNeedsPoll(row: SceneHistoryEntry, now: number): boolean {
  const open = row.state === "queued" || row.state === "leased" || row.state === "verifying" || row.state === "settling";
  const bareSuccess = row.state === "succeeded" && !row.resultAssetId;
  if (!open && !bareSuccess) return false;
  return now - row.createdAt < SCENE_CLIENT_DEADLINE_MS + 5 * 60_000;
}
