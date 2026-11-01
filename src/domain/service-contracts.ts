import type { ProductDocument, Rect } from "./contracts";

export interface ServiceAsset {
  assetId: string; mime: "image/png"; bytes: number; sha256: string; width: number; height: number;
  bounds: Rect; hasAlpha: boolean; transparent: boolean; sourceAssetId: string | null;
  expiresAt: number; url: string; urlExpiresAt: number;
}
export interface ServiceJobRequest {
  version: 1; requestId: string; kind: "segment" | "product";
  documentId: string; documentRevision: number; sourceAssetId: string;
  foregroundAssetId?: string; scene?: ProductDocument["scene"];
  canvas?: ProductDocument["canvas"]; placement?: Rect;
}
export interface ServiceJob {
  jobId: string; state: "queued" | "leased" | "verifying" | "settling" | "succeeded" | "failed" | "cancelled";
  mode: "internal"; billing: { mode: "unbilled_internal"; units: 0 } | {mode:'credits_internal';units:number;state:'held'|'confirmed'|'released'}; request: ServiceJobRequest;
  error: string | null; outputs?: Partial<Record<"foreground" | "alpha" | "final", ServiceAsset>>;
  queue?: { workerOnline: boolean };
}
export interface InternalDraft {
  version: 1; authUserId?: string; document: ProductDocument;
  pending?: { request: ServiceJobRequest; jobId?: string; quoteId?:string };
  /** 最近一次已确认的候选组。刷新后用 groupId 继续查询；创建请求可安全重发（服务端按 groupId + 请求内容幂等）。 */
  group?: { groupId: string; request: ServiceGroupRequest; confirmed?: true };
  result?: { assetId: string; document: ProductDocument };
  view: "draft" | "result";
}
export interface ServiceQuote {quoteId:string;units:number;expiresAt:number;pricingVersion:string;request:ServiceJobRequest;availableCredits:number;}
export interface ServiceExecution {status:'online'|'offline'|'unknown'}

/** 生成组里每张候选共用的商品模板：与单张商品请求相同，但不含 version / requestId / kind（由服务端派生）。 */
export interface ServiceGroupItemTemplate {
  documentId: string; documentRevision: number; sourceAssetId: string; foregroundAssetId: string;
  scene: ProductDocument["scene"]; canvas: ProductDocument["canvas"]; placement: Rect;
}
/** 四候选请求。浏览器只决定张数和构图，价格、seed 与派发顺序都由服务端决定。 */
export interface ServiceGroupRequest { version: 1; requestId: string; kind: "candidates"; count: number; item: ServiceGroupItemTemplate }
export interface ServiceGroupQuote {
  groupId: string; units: number; unitUnits: number; count: number; pricingVersion: string; expiresAt: number;
  request: ServiceGroupRequest; availableCredits: number;
}
/** waiting/awaiting_credits 还没有冻结积分；queued 之后与单张任务的状态相同。 */
export type ServiceGroupItemState = "waiting" | "awaiting_credits" | "queued" | "leased" | "verifying" | "settling" | "succeeded" | "failed" | "cancelled";
export interface ServiceGroupItem {
  index: number; attempt: number; units: number; state: ServiceGroupItemState;
  jobId?: string; billing?: "held" | "confirmed" | "released"; error?: string | null;
  queue?: { workerOnline: boolean }; result?: ServiceAsset;
}
export interface ServiceGroup {
  groupId: string; kind: "candidates"; request: ServiceGroupRequest; count: number;
  status: "quoted" | "running" | "paused" | "completed" | "cancelled";
  pauseReason: "insufficient_credits" | "reservation_failed" | null;
  budgetUnits: number; unitUnits: number; settledUnits: number; heldUnits: number;
  pricingVersion: string; createdAt: number; items: ServiceGroupItem[];
}

/**
 * 批量请求（设计 §4）：每件商品一项，每项带自己的素材和构图。浏览器只决定“提交哪些商品、各自的构图”，
 * 价格、派发顺序和每个工作项的 requestId 都由服务端决定。被排除的商品不放进 entries，所以不产生订单。
 */
export interface ServiceBatchEntry extends ServiceGroupItemTemplate { entryId: string }
export interface ServiceBatchRequest { version: 1; requestId: string; kind: "batch"; entries: ServiceBatchEntry[] }
/** 批量报价不回显请求（有几十 KB）：页面保存着自己提交的那份，确认时原样再发一次。 */
export interface ServiceBatchQuote {
  groupId: string; kind: "batch"; units: number; unitUnits: number; count: number; pricingVersion: string; expiresAt: number; availableCredits: number;
}
/** 批量的每一项带自己的 entryId 和场景（换了设备的页面没有本地记录，下载文件命名要用场景）。 */
export interface ServiceBatchItem extends ServiceGroupItem { entryId: string; scene?: ProductDocument["scene"] }
/** 批量组视图：与候选组相同的预算与状态字段，但带 entryIds，不重复返回请求。 */
export interface ServiceBatch extends Omit<ServiceGroup, "kind" | "request" | "items"> {
  kind: "batch"; entryIds: string[]; items: ServiceBatchItem[];
}

/**
 * “我的批次”列表里的一行（GET /groups?kind=batch&limit=N）：只有摘要——状态、进度计数、金额、时间——
 * 没有请求内容，也不逐项读取控制面。要看每一项的状态和结果图，再按 groupId 取完整视图（ServiceBatch）。
 * counts 里 running 是“已冻结积分、排队或正在生成”，列表不区分排队和生成；cancelled 是用户停止时被释放的项，
 * 没来得及开始的项仍算 waiting（组的状态是 cancelled 时页面把它们显示为“已停止”）。
 */
export interface ServiceGroupSummary {
  groupId: string; kind: "candidates" | "batch"; status: ServiceGroup["status"]; pauseReason: ServiceGroup["pauseReason"];
  count: number; unitUnits: number; budgetUnits: number; settledUnits: number; heldUnits: number; pricingVersion: string;
  counts: { succeeded: number; running: number; failed: number; cancelled: number; waiting: number };
  createdAt: number; confirmedAt: number | null; finishedAt: number | null;
}
