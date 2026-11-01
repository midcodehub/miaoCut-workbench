"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalAsset, Locale } from "@/domain/contracts";
import {
  DEFAULT_PLAN, HISTORY_LIMIT, MAX_BATCH_GROUPS, MAX_BATCH_PRODUCTS, analyzeSubject, batchActive, batchRequestFor, checkSubject, entryOutcome, failedEntryIds, included,
  remoteBatchValid, remoteZipName, summaryActive, validBatchDraft, validGroupSummaries, zipFiles, zipName,
  type BatchDraft, type BatchEntryRecord, type BatchGroupRecord, type BatchPlan, type EntryOutcome,
} from "@/domain/batch";
import type { ServiceBatch, ServiceBatchItem, ServiceBatchQuote, ServiceBatchRequest, ServiceExecution, ServiceGroupSummary, ServiceJobRequest } from "@/domain/service-contracts";
import { AssetError, downloadPng } from "./assets";
import { ServiceError, WorkbenchService } from "./service-api";

export type BatchProblem = "login" | "access" | "error" | "storage" | "insufficient" | "quoteExpired" | "paused" | "offline" | "unknown" | "unavailable" | "tooManyBatches" | "empty" | "notFound" | null;
/** 一次报价：服务端的价格，加上页面提交的那份请求（报价响应不回显请求，确认时要原样再发一次）。 */
export interface BatchOffer { quote: ServiceBatchQuote; request: ServiceBatchRequest; redo: boolean }

/** 同时上传的商品数。上传不占 GPU，但不要一次打开太多连接。 */
const UPLOAD_SLOTS = 3;
/** 同时提交的“提取主体”任务数。账户同时最多 3 笔冻结订单，留 1 个给其他操作；GPU 本身一次只跑一个。 */
const SEGMENT_SLOTS = 2;
const POLL_MS = 2000;
/** “我的批次”列表的刷新间隔：有批次在服务端运行时 10 秒一次，否则 60 秒一次（列表只有摘要，一次响应约 1 KB × 行数）。 */
const HISTORY_ACTIVE_MS = 10_000, HISTORY_IDLE_MS = 60_000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const errorCode = (error: unknown) => (error instanceof ServiceError || error instanceof AssetError ? error.code : "error").slice(0, 64);
/** 读取前景的 Alpha：缩小到长边 ≤256 再统计，20 件商品也不会卡住页面。 */
async function inspectForeground(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height)), width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new AssetError("image_decode");
    context.drawImage(bitmap, 0, 0, width, height);
    const metrics = analyzeSubject(context.getImageData(0, 0, width, height).data, width, height);
    canvas.width = canvas.height = 0;
    return { metrics, reasons: checkSubject(metrics) };
  } finally { bitmap.close(); }
}

export function useBatch(sessionKey: string) {
  const api = useMemo(() => new WorkbenchService(sessionKey), [sessionKey]);
  const storageKey = `mc.workbench.batch.v1.${sessionKey}`;
  const [draft, setDraft] = useState<BatchDraft>({ version: 1, authUserId: "", entries: [], plan: structuredClone(DEFAULT_PLAN), groups: [] });
  const current = useRef(draft);
  const [connected, setConnected] = useState(false), [problem, setProblem] = useState<BatchProblem>(null);
  const [locale, setLocaleState] = useState<Locale>("zh"), [dark, setDark] = useState(false);
  const [pricing, setPricing] = useState<{ segment: number; product: number; admissionOpen: boolean }>();
  const [limits, setLimits] = useState<{ maxItems: number; maxProducts: number; ratios: string[] } | null>(null);
  const [execution, setExecution] = useState<ServiceExecution["status"]>("unknown"), [resume, setResume] = useState(0);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [offer, setOffer] = useState<BatchOffer>(), [quoting, setQuoting] = useState(false), [busy, setBusy] = useState(false);
  const [views, setViews] = useState<Record<string, ServiceBatch>>({}), [poll, setPoll] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, LocalAsset>>({}), [results, setResults] = useState<Record<string, LocalAsset>>({});
  const files = useRef(new Map<string, File>()), running = useRef(new Set<string>()), uploading = useRef(new Set<string>());
  const quoteLock = useRef(false), loadingImages = useRef(new Set<string>());
  // 我的批次：服务端列表（换了设备也找得到）；opened 是点开查看的、本页面没有跟踪的批次。
  const [history, setHistory] = useState<ServiceGroupSummary[]>([]), [historyState, setHistoryState] = useState<"idle" | "loading" | "error">("idle"), [opened, setOpened] = useState<string | null>(null);
  const historyActive = useRef(false);

  const replace = useCallback((next: BatchDraft) => {
    if (!next.authUserId) throw new ServiceError("login_required", 401);
    // 上传中的商品没有保存价值（文件刷新后就没了），不写入本地；校验不通过的记录也不会被读回。
    const stored = { ...next, entries: next.entries.filter(entry => entry.stage !== "uploading") };
    try { localStorage.setItem(`${storageKey}.${next.authUserId}`, JSON.stringify(stored)); } catch { throw new ServiceError("storage_error"); }
    current.current = next; setDraft(next);
  }, [storageKey]);
  const report = useCallback((error: unknown) => {
    setProblem(error instanceof ServiceError && error.status === 401 ? "login" :
      error instanceof ServiceError && error.code === "internal_access_required" ? "access" :
      error instanceof ServiceError && error.code === "billing_paused" ? "paused" :
      error instanceof ServiceError && error.code === "quote_expired" ? "quoteExpired" :
      error instanceof ServiceError && error.code === "insufficient" ? "insufficient" :
      error instanceof ServiceError && error.code === "storage_error" ? "storage" : "error");
  }, []);
  const patchEntry = useCallback((entryId: string, patch: Partial<BatchEntryRecord> | ((entry: BatchEntryRecord) => Partial<BatchEntryRecord>), clear: (keyof BatchEntryRecord)[] = []) => {
    const state = current.current, entry = state.entries.find(item => item.entryId === entryId);
    if (!entry) return;
    const next: BatchEntryRecord = { ...entry, ...(typeof patch === "function" ? patch(entry) : patch) };
    for (const key of clear) delete next[key];
    try { replace({ ...state, entries: state.entries.map(item => (item.entryId === entryId ? next : item)) }); } catch (error) { report(error); }
  }, [replace, report]);

  // 启动：读取能力、恢复本地记录。批量和积分账本绑定，不计费的内部模式下页面只显示说明。
  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      setConnected(false); setThumbs({}); setResults({}); setViews({}); loadingImages.current.clear(); setHistory([]); setHistoryState("idle"); setOpened(null);
      setDark(document.documentElement.classList.contains("dark"));
      try { setLocaleState(localStorage.getItem("mc.workbench.locale") === "en" ? "en" : "zh"); } catch { /* 语言偏好是可选的 */ }
      try {
        const caps = await api.call<{ mode: string; version: number; identity?: { authUserId: string }; execution?: ServiceExecution; batch?: { maxItems: number; maxProducts: number; ratios: string[] } | null;
          billing?: { mode: string; segment?: number; product?: number; admissionOpen?: boolean } }>("capabilities", undefined, controller.signal);
        const identity = caps.identity?.authUserId;
        const paid = caps.version === 2 && caps.billing?.mode === "credits_internal" && [caps.billing.segment, caps.billing.product].every(n => Number.isSafeInteger(n) && n! >= 0);
        if (caps.mode !== "internal" || !identity || !/^[0-9a-f-]{36}$/i.test(identity)) throw new ServiceError("protocol_mismatch");
        if (controller.signal.aborted) return;
        setPricing(paid ? { segment: caps.billing!.segment!, product: caps.billing!.product!, admissionOpen: caps.billing!.admissionOpen === true } : undefined);
        setLimits(paid && caps.batch && Array.isArray(caps.batch.ratios) && caps.batch.ratios.includes("1:1") ? caps.batch : null);
        setExecution(caps.execution?.status === "online" ? "online" : caps.execution?.status === "offline" ? "offline" : "unknown");
        let saved: BatchDraft = { version: 1, authUserId: identity, entries: [], plan: structuredClone(DEFAULT_PLAN), groups: [] };
        try {
          const stored = JSON.parse(localStorage.getItem(`${storageKey}.${identity}`) || "null");
          if (validBatchDraft(stored) && stored.authUserId === identity) saved = stored;
        } catch { /* 损坏的本地记录不会变成服务请求 */ }
        if (!controller.signal.aborted) { current.current = saved; setDraft(saved); setConnected(true); setProblem(null); }
      } catch (error) { if (!controller.signal.aborted) report(error); }
    }
    void initialize(); return () => controller.abort();
  }, [api, storageKey, report, resume]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === sessionKey) setResume(n => n + 1); };
    const authChanged = () => setResume(n => n + 1);
    window.addEventListener("storage", changed); window.addEventListener("mc.workbench-auth", authChanged);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener("mc.workbench-auth", authChanged); };
  }, [sessionKey]);
  // 15 秒查一次 GPU 是否在线（上传和提交新任务需要在线）。
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const caps = await api.call<{ execution?: ServiceExecution }>("capabilities", undefined, controller.signal);
        if (!controller.signal.aborted) setExecution(caps.execution?.status === "online" ? "online" : caps.execution?.status === "offline" ? "offline" : "unknown");
      } catch { if (!controller.signal.aborted) setExecution("unknown"); }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 15000);
    }
    timer = setTimeout(() => void refresh(), 15000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, connected]);

  // ── 每件商品：上传 → 提交提取任务 → 轮询 → 读取前景并做主体检查 ──────────────────────────────
  const uploadEntry = useCallback(async (entryId: string) => {
    const file = files.current.get(entryId);
    if (!file || uploading.current.has(entryId)) return;
    uploading.current.add(entryId);
    try {
      const source = await api.upload(file, percent => setProgress(all => ({ ...all, [entryId]: percent })));
      patchEntry(entryId, { stage: "uploaded", sourceAssetId: source.assetId });
    } catch (error) {
      if (error instanceof ServiceError && error.status === 401) report(error);
      patchEntry(entryId, { stage: "failed", error: errorCode(error) });
    } finally {
      uploading.current.delete(entryId); files.current.delete(entryId);
      setProgress(all => { const next = { ...all }; delete next[entryId]; return next; });
    }
  }, [api, patchEntry, report]);

  const extractEntry = useCallback(async (entryId: string, signal: AbortSignal) => {
    if (running.current.has(entryId)) return;
    running.current.add(entryId);
    const same = () => !signal.aborted && current.current.entries.some(entry => entry.entryId === entryId && entry.stage === "extracting");
    try {
      let entry = current.current.entries.find(item => item.entryId === entryId)!;
      const request = (requestId: string): ServiceJobRequest => ({ version: 1, requestId, kind: "segment", documentId: entry.documentId, documentRevision: 0, sourceAssetId: entry.sourceAssetId! });
      if (!entry.segment) {
        const requestId = crypto.randomUUID(), quote = await api.quote(request(requestId));
        // 内测期间提取免费。价格不是 0 时不自动确认：不能在用户没有看到的情况下花积分。
        if (quote.units !== 0) throw new ServiceError("segment_not_free");
        if (signal.aborted) return;
        patchEntry(entryId, { stage: "extracting", segment: { requestId, quoteId: quote.quoteId } });
        entry = current.current.entries.find(item => item.entryId === entryId)!;
      }
      if (!entry.segment) return;
      let jobId = entry.segment.jobId;
      if (!jobId) {
        // 创建请求按 requestId 幂等：响应丢失后刷新重发，服务端返回同一个任务。
        const job = await api.create(request(entry.segment.requestId), signal, entry.segment.quoteId);
        if (!same()) return;
        jobId = job.jobId;
        patchEntry(entryId, current => ({ segment: { ...current.segment!, jobId } }));
      }
      while (same()) {
        const job = await api.job(jobId, signal);
        if (!same()) return;
        if (job.state === "succeeded") {
          const foreground = job.outputs?.foreground;
          if (!foreground) throw new ServiceError("missing_foreground");
          const image = await api.image(foreground, signal);
          const { metrics, reasons } = await inspectForeground(image.blob);
          if (!same()) return;
          patchEntry(entryId, { stage: "ready", foregroundAssetId: foreground.assetId, bounds: foreground.bounds, check: { reasons, metrics } }, ["segment", "error"]);
          setThumbs(all => ({ ...all, [entryId]: image }));
          return;
        }
        if (job.state === "failed" || job.state === "cancelled") { patchEntry(entryId, { stage: "failed", error: job.error === "job_expired" ? "queueExpired" : job.state }, ["segment"]); return; }
        await sleep(POLL_MS, signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ServiceError && error.status === 401) report(error);
      const expired = error instanceof ServiceError && ["asset_not_found", "asset_expired", "foreground_lineage"].includes(error.code);
      patchEntry(entryId, { stage: "failed", error: expired ? "expired" : errorCode(error) }, ["segment"]);
    } finally { running.current.delete(entryId); }
  }, [api, patchEntry, report]);

  // 调度：上传最多 3 件同时进行；提取任务最多同时 2 个（占着名额的是“正在提交”和“已有任务在排队或执行”的商品），其余排队。
  // 刷新后“提取中”且已有任务的商品按保存的任务继续查询，不占用新的提交名额逻辑、也不重复提交。
  // 查询循环共用一个贯穿整个连接周期的 AbortController：商品状态每变一次就重启所有循环既浪费请求，也会打断正在提交的任务。
  const pipeline = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    pipeline.current = controller; running.current.clear();
    return () => controller.abort();
  }, [connected, resume, api]);
  const entriesKey = draft.entries.map(entry => `${entry.entryId}:${entry.stage}:${entry.segment?.jobId ?? ""}`).join(",");
  useEffect(() => {
    const signal = pipeline.current?.signal;
    if (!connected || !signal || signal.aborted) return;
    const entries = current.current.entries;
    let uploads = uploading.current.size;
    for (const entry of entries) {
      if (entry.stage === "uploading" && !uploading.current.has(entry.entryId) && uploads < UPLOAD_SLOTS && execution === "online") { uploads++; void uploadEntry(entry.entryId); }
    }
    for (const entry of entries) {
      if (entry.stage === "extracting" && entry.segment?.jobId && !running.current.has(entry.entryId)) void extractEntry(entry.entryId, signal);
    }
    let active = entries.filter(entry => entry.stage === "extracting" && (running.current.has(entry.entryId) || !!entry.segment?.jobId)).length;
    for (const entry of entries) {
      if (active >= SEGMENT_SLOTS || execution !== "online") break;
      const waiting = entry.stage === "uploaded" || (entry.stage === "extracting" && !entry.segment?.jobId && !running.current.has(entry.entryId));
      if (!waiting) continue;
      if (entry.stage === "uploaded") patchEntry(entry.entryId, { stage: "extracting" });
      active++; void extractEntry(entry.entryId, signal);
    }
  }, [connected, entriesKey, execution, uploadEntry, extractEntry, patchEntry, resume]);

  // 刷新后已就绪的商品：补读前景缩略图（只读元数据和图片，不提交任何任务）。
  // 下载共用整个连接周期的 AbortController（见上面的说明）：每到一张图就重启其余下载会让大批量时反复取消、重来。
  useEffect(() => {
    const signal = pipeline.current?.signal;
    if (!connected || !signal || signal.aborted) return;
    for (const entry of current.current.entries) {
      if (entry.stage !== "ready" || !entry.foregroundAssetId || thumbs[entry.entryId] || loadingImages.current.has(entry.entryId)) continue;
      loadingImages.current.add(entry.entryId);
      void api.asset(entry.foregroundAssetId, signal).then(asset => api.image(asset, signal)).then(image => {
        if (!signal.aborted) setThumbs(all => ({ ...all, [entry.entryId]: image }));
      }).catch(error => { loadingImages.current.delete(entry.entryId); if (!signal.aborted && error instanceof ServiceError && ["asset_not_found", "asset_expired"].includes(error.code)) patchEntry(entry.entryId, { stage: "failed", error: "expired" }); });
    }
  }, [api, connected, entriesKey, thumbs, patchEntry]);

  // ── 批次：确认（幂等）→ 轮询 → 停止 / 继续 ─────────────────────────────────────────────────────
  const groupsKey = draft.groups.map(group => `${group.groupId}:${group.confirmed ? 1 : 0}`).join(",");
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController(), signal = controller.signal;
    const exists = (id: string) => current.current.groups.some(group => group.groupId === id);
    async function track(record: BatchGroupRecord) {
      try {
        let view: ServiceBatch;
        if (!record.confirmed) {
          // 确认请求按 groupId + 请求内容幂等：确认响应丢失或刷新后重发，服务端返回同一个批次，不会再冻结积分。
          view = await api.createBatch(record.groupId, record.request, signal);
          if (signal.aborted || !exists(record.groupId)) return;
          setViews(all => ({ ...all, [record.groupId]: view }));
          const state = current.current;
          replace({ ...state, groups: state.groups.map(group => (group.groupId === record.groupId ? { ...group, confirmed: true } : group)) });
          return;
        }
        while (!signal.aborted && exists(record.groupId)) {
          view = await api.batch(record.groupId, signal);
          if (signal.aborted || !exists(record.groupId)) return;
          setViews(all => ({ ...all, [record.groupId]: view }));
          // 没有执行中的项且批次不会自己推进（完成、停止、等待积分）时停止轮询；继续或停止操作会重新开始。
          if (!batchActive(view)) return;
          await sleep(POLL_MS, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof ServiceError ? error.code : "";
        if (!record.confirmed && ["quote_expired", "quote_changed", "quote_not_found", "insufficient", "billing_paused", "invalid_fields", "invalid_batch", "batch_count"].includes(code) && exists(record.groupId)) {
          // 确认没有成功，不存在任何冻结：丢弃这条记录，让用户重新报价。
          try { const state = current.current; replace({ ...state, groups: state.groups.filter(group => group.groupId !== record.groupId) }); report(error); } catch (storageError) { report(storageError); }
        } else if (code === "group_not_found" && exists(record.groupId)) {
          try { const state = current.current; replace({ ...state, groups: state.groups.filter(group => group.groupId !== record.groupId) }); } catch (storageError) { report(storageError); }
        } else report(error);
      }
    }
    for (const record of current.current.groups) void track(record);
    return () => controller.abort();
  }, [api, connected, groupsKey, poll, replace, report, resume]);

  // ── 我的批次：服务端列表 + 点开本页没有跟踪的批次 ─────────────────────────────────────────────
  // 列表只有摘要（状态、进度计数、金额、时间），不带请求，也不逐项读取：批次是否在运行由服务端的状态决定。
  // 响应先过 validGroupSummaries 再显示，形状或计数对不上的行直接丢掉。
  const refreshHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryState(state => (state === "idle" ? "loading" : state));
    try {
      const rows = validGroupSummaries(await api.batches(HISTORY_LIMIT, signal));
      if (signal?.aborted) return;
      historyActive.current = rows.some(summaryActive);
      setHistory(rows); setHistoryState("idle");
    } catch (error) {
      if (signal?.aborted) return;
      setHistoryState("error");
      if (error instanceof ServiceError && error.status === 401) report(error);
    }
  }, [api, report]);
  const historyReady = connected && !!limits;
  useEffect(() => {
    if (!historyReady) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function loop() {
      await refreshHistory(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void loop(), historyActive.current ? HISTORY_ACTIVE_MS : HISTORY_IDLE_MS);
    }
    void loop(); // groupsKey 变化（新确认了一个批次）时重新开始，列表里马上出现新的一行
    return () => { controller.abort(); clearTimeout(timer); };
  }, [historyReady, groupsKey, refreshHistory, resume]);
  // 本页跟踪的批次状态变化（开始、暂停、完成、停止）时马上刷新列表，不等下一个定时：列表里那一行不应该比上面的进度条慢。
  // 第一次渲染只记下状态，不请求（上面的循环已经在加载）。
  const localStatusKey = draft.groups.map(group => { const view = views[group.groupId]; return `${group.groupId}:${view ? `${view.status}:${batchActive(view) ? 1 : 0}` : ""}`; }).join(",");
  const lastLocalStatus = useRef<string | null>(null);
  useEffect(() => {
    const first = lastLocalStatus.current === null;
    lastLocalStatus.current = localStatusKey;
    if (!first && historyReady) void refreshHistory();
  }, [historyReady, localStatusKey, refreshHistory]);
  // 点开一个本页没有跟踪的批次：按 groupId 取完整视图（每一项的状态和结果图），批次还在推进就继续轮询。
  // 本页跟踪的批次（localStorage 里有记录）由上面的批次轮询负责，这里不重复请求。
  useEffect(() => {
    if (!connected || !opened || current.current.groups.some(group => group.groupId === opened)) return;
    const controller = new AbortController(), signal = controller.signal, groupId = opened;
    void (async () => {
      try {
        while (!signal.aborted) {
          const view = await api.batch(groupId, signal);
          if (signal.aborted) return;
          if (!remoteBatchValid(view, groupId)) throw new ServiceError("protocol_mismatch");
          setViews(all => ({ ...all, [groupId]: view }));
          if (!batchActive(view)) return;
          await sleep(POLL_MS, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ServiceError && error.code === "group_not_found") { setOpened(null); setProblem("notFound"); } else report(error);
      }
    })();
    return () => controller.abort();
  }, [api, connected, opened, poll, report, resume]);

  // 只下载已经完成的结果图；下载时校验大小和 SHA-256，失败的下一次轮询再试。
  const succeededAssets = useMemo(() => Object.values(views).flatMap(view => view.items.flatMap(item => (item.result ? [item.result] : []))), [views]);
  useEffect(() => {
    const signal = pipeline.current?.signal;
    if (!connected || !signal || signal.aborted) return;
    for (const asset of succeededAssets) {
      if (loadingImages.current.has(asset.assetId)) continue;
      loadingImages.current.add(asset.assetId);
      void api.image(asset, signal).then(image => {
        // 批次在下载途中被收起（loadingImages 已清掉这张图）就丢弃，不再占内存。
        if (!signal.aborted && loadingImages.current.has(asset.assetId)) setResults(all => ({ ...all, [asset.assetId]: image }));
      }).catch(() => { loadingImages.current.delete(asset.assetId); });
    }
  }, [api, connected, succeededAssets]);

  // ── 页面操作 ─────────────────────────────────────────────────────────────────────────────────
  const locked = useMemo(() => new Set(draft.groups.flatMap(group => group.request.entries.map(entry => entry.entryId))), [draft.groups]);
  const addFiles = useCallback((list: File[]) => {
    const state = current.current;
    if (!connected || list.length === 0) return;
    const room = MAX_BATCH_PRODUCTS - state.entries.length, accepted = list.slice(0, Math.max(0, room));
    if (accepted.length === 0) return;
    const created = accepted.map((file): BatchEntryRecord => ({ entryId: crypto.randomUUID(), documentId: crypto.randomUUID(), fileName: file.name.slice(0, 255), stage: "uploading", excluded: false }));
    created.forEach((entry, index) => files.current.set(entry.entryId, accepted[index]));
    try { replace({ ...state, entries: [...state.entries, ...created] }); setProblem(null); } catch (error) { report(error); }
  }, [connected, replace, report]);
  const replaceEntry = useCallback((entryId: string, file: File) => {
    if (locked.has(entryId)) return;
    files.current.set(entryId, file);
    setThumbs(all => { const next = { ...all }; delete next[entryId]; return next; });
    patchEntry(entryId, { stage: "uploading", fileName: file.name.slice(0, 255), documentId: crypto.randomUUID(), excluded: false },
      ["sourceAssetId", "segment", "foregroundAssetId", "bounds", "check", "error"]);
  }, [locked, patchEntry]);
  const retryEntry = useCallback((entryId: string) => {
    const entry = current.current.entries.find(item => item.entryId === entryId);
    if (!entry || entry.stage !== "failed" || locked.has(entryId)) return;
    // 有源图就只重新提取；没有（上传失败或刷新中断）需要用户重新选择文件，由界面提示。
    if (entry.sourceAssetId) patchEntry(entryId, { stage: "uploaded" }, ["segment", "error"]);
  }, [locked, patchEntry]);
  const setExcluded = useCallback((entryId: string, excluded: boolean) => { if (!locked.has(entryId)) patchEntry(entryId, { excluded }); }, [locked, patchEntry]);
  const removeEntry = useCallback((entryId: string) => {
    if (locked.has(entryId)) return;
    files.current.delete(entryId);
    const state = current.current;
    try { replace({ ...state, entries: state.entries.filter(entry => entry.entryId !== entryId) }); } catch (error) { report(error); }
    setThumbs(all => { const next = { ...all }; delete next[entryId]; return next; });
  }, [locked, replace, report]);
  const setPlan = useCallback((plan: BatchPlan) => {
    setOffer(undefined);
    try { replace({ ...current.current, plan }); } catch (error) { report(error); }
  }, [replace, report]);
  /** 全部结束后开始新的一批：清空商品和已记住的批次。 */
  const startOver = useCallback(() => {
    files.current.clear(); setOffer(undefined); setViews({}); setThumbs({}); setResults({}); loadingImages.current.clear(); setOpened(null);
    try { replace({ ...current.current, entries: [], groups: [] }); } catch (error) { report(error); }
  }, [replace, report]);

  const ready = draft.entries.filter(included);
  const outcomes = useMemo(() => {
    const map: Record<string, EntryOutcome | undefined> = {};
    for (const entry of draft.entries) map[entry.entryId] = entryOutcome(entry.entryId, draft.groups, views);
    return map;
  }, [draft.entries, draft.groups, views]);
  const newest = draft.groups.at(-1), newestView = newest ? views[newest.groupId] : undefined;
  const activeGroup = draft.groups.find(group => { const view = views[group.groupId]; return !group.confirmed || (view ? batchActive(view) || view.status === "paused" : true); });

  const quoteRequest = useCallback(async (request: ServiceBatchRequest | null, redo: boolean) => {
    if (execution !== "online") { setProblem(execution); return; }
    if (!connected || !pricing || pricing.admissionOpen === false || !limits || quoteLock.current) return;
    if (!request) { setProblem("empty"); return; }
    if (activeGroup) return;
    quoteLock.current = true; setQuoting(true);
    try {
      const quote = await api.batchQuote(request);
      if (!Number.isSafeInteger(quote.units) || quote.units < 0 || quote.expiresAt <= Date.now() || quote.kind !== "batch" || quote.count !== request.entries.length || !/^[0-9a-f-]{36}$/i.test(quote.groupId))
        throw new ServiceError("invalid_quote");
      setOffer({ quote, request, redo }); setProblem(null);
    } catch (error) { report(error); }
    finally { quoteLock.current = false; setQuoting(false); }
  }, [activeGroup, api, connected, execution, limits, pricing, report]);
  /** 确认预算前才报价：用户检查主体、调整方案的时候不会创建报价（报价 5 分钟有效）。 */
  const requestQuote = useCallback(() => quoteRequest(batchRequestFor(current.current.entries, current.current.plan, crypto.randomUUID()), false), [quoteRequest]);
  /** 重新生成失败的项：用这几项（沿用原来的场景和构图）再提交一个新批次，成功的项保留。 */
  const requestRedo = useCallback(async () => {
    const state = current.current;
    if (state.groups.length >= MAX_BATCH_GROUPS) { setProblem("tooManyBatches"); return; }
    const ids = new Set(state.entries.filter(entry => outcomes[entry.entryId]?.item.state === "failed").map(entry => entry.entryId)), picked: ServiceBatchRequest["entries"] = [];
    for (const record of [...state.groups].reverse()) for (const entry of record.request.entries) if (ids.has(entry.entryId) && !picked.some(item => item.entryId === entry.entryId)) picked.push(entry);
    const order = state.entries.map(entry => entry.entryId);
    picked.sort((a, b) => order.indexOf(a.entryId) - order.indexOf(b.entryId));
    await quoteRequest(picked.length ? { version: 1, requestId: crypto.randomUUID(), kind: "batch", entries: picked } : null, true);
  }, [outcomes, quoteRequest]);
  const acceptOffer = useCallback(() => {
    if (execution !== "online") { setProblem(execution); return; }
    if (!offer || !connected || activeGroup) return;
    if (offer.quote.expiresAt <= Date.now()) { setOffer(undefined); setProblem("quoteExpired"); return; }
    // 先持久化 groupId 再提交确认：确认响应丢失时，刷新后用同一个 groupId 继续，不会建第二批。
    try {
      const state = current.current;
      replace({ ...state, groups: [...state.groups, { groupId: offer.quote.groupId, request: offer.request }] });
      setOffer(undefined); setProblem(null);
    } catch (error) { report(error); }
  }, [activeGroup, connected, execution, offer, replace, report]);
  const groupAction = useCallback(async (groupId: string, action: "stop" | "resume") => {
    if (busy) return;
    setBusy(true);
    try {
      const view = action === "stop" ? await api.cancelBatch(groupId) : await api.resumeBatch(groupId);
      setViews(all => ({ ...all, [groupId]: view })); setPoll(n => n + 1);
    } catch (error) { report(error); }
    finally { setBusy(false); }
  }, [api, busy, report]);

  // ── 我的批次：点开 / 收起 / 下载（本页没有跟踪的批次） ──────────────────────────────────────────
  const openGroup = useCallback((groupId: string) => { if (!current.current.groups.some(group => group.groupId === groupId)) setOpened(groupId); }, []);
  const closeGroup = useCallback(() => {
    const groupId = opened;
    setOpened(null);
    if (!groupId) return;
    const view = views[groupId];
    if (!view) return;
    // 收起时释放这个批次的结果图（最多 60 张）：它们只为这次查看下载，页面不需要一直占着内存。
    const assetIds = new Set(view.items.flatMap(item => (item.result ? [item.result.assetId] : [])));
    assetIds.forEach(id => loadingImages.current.delete(id));
    setResults(all => Object.fromEntries(Object.entries(all).filter(([id]) => !assetIds.has(id))));
    setViews(all => { const next = { ...all }; delete next[groupId]; return next; });
  }, [opened, views]);
  const remoteResult = useCallback((item: ServiceBatchItem) => (item.state === "succeeded" && item.result ? results[item.result.assetId] : undefined), [results]);
  const downloadRemoteOne = useCallback((item: ServiceBatchItem) => {
    const image = remoteResult(item);
    if (image) downloadPng(image.blob, remoteZipName(item.index, item.scene, new Set()));
  }, [remoteResult]);
  /** 把这个批次已完成的结果打成 ZIP（文件名 product-NN_场景_1x1.png），在浏览器里完成。 */
  const downloadRemoteZip = useCallback(async (groupId: string) => {
    const view = views[groupId], used = new Set<string>(), items: { name: string; data: Uint8Array }[] = [];
    for (const item of view?.items ?? []) {
      const image = remoteResult(item);
      if (image) items.push({ name: remoteZipName(item.index, item.scene, used), data: new Uint8Array(await image.blob.arrayBuffer()) });
    }
    if (items.length === 0) return 0;
    const chunks = await zipFiles(items);
    downloadPng(new Blob(chunks as BlobPart[], { type: "application/zip" }), `miaocut-batch-${groupId.slice(0, 8)}.zip`);
    return items.length;
  }, [remoteResult, views]);

  // ── 下载 ─────────────────────────────────────────────────────────────────────────────────────
  const resultOf = useCallback((entryId: string) => { const outcome = outcomes[entryId]; return outcome?.item.state === "succeeded" && outcome.item.result ? results[outcome.item.result.assetId] : undefined; }, [outcomes, results]);
  const scene = (entryId: string) => draft.groups.slice().reverse().map(group => group.request.entries.find(entry => entry.entryId === entryId)?.scene).find(Boolean) ?? draft.plan.scene;
  const downloadOne = useCallback((entryId: string) => {
    const entry = draft.entries.find(item => item.entryId === entryId), image = resultOf(entryId);
    if (entry && image) downloadPng(image.blob, zipName(entry.fileName, scene(entryId), "1:1", new Set()));
  }, [draft.entries, resultOf]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 把已完成的结果按页面顺序打成 ZIP，在浏览器里完成，服务器不额外存一份。 */
  const downloadZip = useCallback(async () => {
    const used = new Set<string>(), items: { name: string; data: Uint8Array }[] = [];
    for (const entry of draft.entries) {
      const image = resultOf(entry.entryId);
      if (image) items.push({ name: zipName(entry.fileName, scene(entry.entryId), "1:1", used), data: new Uint8Array(await image.blob.arrayBuffer()) });
    }
    if (items.length === 0) return 0;
    const chunks = await zipFiles(items);
    downloadPng(new Blob(chunks as BlobPart[], { type: "application/zip" }), `miaocut-batch-${new Date().toISOString().slice(0, 10)}.zip`);
    return items.length;
  }, [draft.entries, resultOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocale = (value: Locale) => {
    setLocaleState(value); document.documentElement.lang = value === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem("mc.workbench.locale", value); } catch { /* 偏好是可选的 */ }
  };
  const toggleTheme = () => {
    const next = !dark; setDark(next); document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* 偏好是可选的 */ }
  };
  return {
    draft, connected, problem, dismissProblem: () => setProblem(null), locale, setLocale, dark, toggleTheme, pricing, limits, execution, progress, thumbs, results,
    entries: draft.entries, plan: draft.plan, setPlan, ready, readyCount: ready.length, locked, outcomes, groups: draft.groups, views, newest, newestView, activeGroup,
    addFiles, replaceEntry, retryEntry, setExcluded, removeEntry, startOver, offer, dismissOffer: () => setOffer(undefined), quoting, busy,
    requestQuote, requestRedo, acceptOffer, stop: (groupId: string) => groupAction(groupId, "stop"), resumeGroup: (groupId: string) => groupAction(groupId, "resume"),
    failedCount: Object.values(outcomes).filter(outcome => outcome?.item.state === "failed").length, failedIds: newestView ? failedEntryIds(newestView) : [],
    history, historyState, refreshHistory: () => refreshHistory(), opened, openedView: opened ? views[opened] : undefined, openGroup, closeGroup, remoteResult, downloadRemoteOne, downloadRemoteZip,
    resultOf, downloadOne, downloadZip, doneCount: Object.values(outcomes).filter(outcome => outcome?.item.state === "succeeded").length,
  };
}
