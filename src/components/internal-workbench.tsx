"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, LoaderCircle, Moon, Scissors, Sun, TriangleAlert, Upload } from "lucide-react";
import type { LocalAsset, Locale, ProductDocument, Rect } from "@/domain/contracts";
import type { InternalDraft, SceneHistoryEntry, ServiceAsset, ServiceJob, ServiceJobRequest, ServiceQuote, ServiceExecution, ServiceGroup, ServiceGroupQuote } from "@/domain/service-contracts";
import { creditPhrase, historyFromJob, historyNeedsPoll, pollBackoffMs, rememberSceneJob, sceneHistory, scenePollErrorAction, scenePollStep, sceneSubmitAllowed, type ScenePhase } from "@/domain/scene-job";
import {accountConfigured} from '@/client/account-auth';
import { WorkbenchService, ServiceError } from "@/client/service-api";
import { messages } from "@/client/i18n";
import { downloadPng } from "@/client/assets";
import { emptyWorkspace, fitPlacement, resizePlacement, SCENES, sizeLimits } from "@/domain/model";
import { validInternalDraft } from "@/domain/service-state";
import { BlobImage } from "./blob-image";
import { EditorCanvas } from "./editor-canvas";
import {SceneComparison} from './scene-comparison';
import {compositionKey} from '@/domain/comparison';
import { CANDIDATE_COUNT, candidateRequest, candidateSnapshot, groupActive, groupMatches } from "@/domain/candidates";
import { CandidateStrip } from "./candidate-strip";
import { writeHandoff } from "@/client/poster-store";
import { writeRecolorHandoff } from "@/client/recolor-store";

const copy = {
  zh: {
    title: "商品场景 · 内部测试", intro: "上传自己的商品，提取主体，再生成一张场景图。",
    notice: "内部 API 模式，仅向测试账户开放，不消耗积分。GPU 推理与商品质量仍需验收，耗时以实际任务状态为准。",
    connecting: "正在确认内部测试权限", ready: "服务已连接", upload: "上传并提取主体", uploadHint: "PNG / JPG / WebP，最大 10 MB，每边不超过 4096 像素。",
    uploading: "正在上传并确认素材", queued: "任务已排队", segment: "正在提取主体", product: "正在生成场景", verifying: "正在校验并保存结果",
    starting: "正在启动 GPU，任务已排队，可能需要几分钟。", reconnecting: "网络中断，正在重新查询，完成后会自动出现。",
    queueExpired: "排队已超时，本次未完成。预留的积分已退回。素材已保留，可以重新发起。",
    coldGpu: "GPU 节点还没就绪。可以照常上传和生成：任务会排队，节点启动后自动开始，通常要几分钟。", unknownGpu: "暂时确认不了 GPU 是否在线。提交不受影响，任务会排队，节点就绪后自动开始。",
    done: "任务已完成", cancelled: "排队任务已取消", failed: "处理未完成，可重新发起。", refunded: (n: number) => `未完成，已退回 ${n} 积分。`, timeout: "已超过 35 分钟仍未结束。页面会继续偶尔查询，积分只在成功后扣除。", missing_output: "任务已结束，结果图还没挂上。下面的列表会继续补。", generate: "AI 生成场景图", waiting: "等待当前任务完成",
    insufficient: "可用积分不足，本次未创建新任务。", quoteExpired: "报价已过期，请重新获取报价。", paused: "新任务暂时停止接收，已有任务仍可查询和结算。",
    access: "当前账号未加入此次内测，请切换到获准的 MiaoCut 账号。",
    error: "连接或操作未完成。已有任务记录会保留，可恢复查询。", login: "请使用已有 MiaoCut 账户登录。同源部署时会复用主站登录态。",
    account: "前往账户登录", resume: "恢复查询", cancel: "取消排队", noSubject: "上传后会自动开始主体提取。", sourceSaved: "原图已保存，生成时复用素材。",
    reuse: "同一商品换场景无需再次上传。", extract: "重新提取主体", viewResult: "查看已完成结果", draft: "继续编辑构图", noResult: "生成成功后可在这里查看并下载。",
    candidates: "生成 4 张候选", candidateOffer: (u: number, n: number, each: number, a: number) => `本次最多 ${u} 积分（${n} 张 × ${each}）· 当前可用 ${a} 积分`,
    candidateRule: "积分逐张预留：完成一张扣一张，未完成或停止的不扣。确认时可用积分需要覆盖全部预算。", candidateConfirm: (u: number) => `确认生成 · 最多 ${u} 积分`,
    candidateBusy: "候选正在生成", previewing: (n: number) => `候选 ${n}`, backToDraft: "返回编辑稿", choose: "设为选定版本", downloadCandidate: "下载这张",
    makePoster: "做成海报", makeRecolor: "精确换色",
    loadingImage: "正在载入图片", imageFailed: "图片没有载入成功（网络较慢或中断，已自动重试过）。任务本身不受影响，可以重新载入。", retryImage: "重新载入图片",
    storage: "浏览器无法保存任务记录，请恢复存储权限后重试。", expired: "素材或结果已失效，请重新上传商品。历史任务不会自动重新执行。", mode: "内部测试 · 不扣积分", returnDemo: "返回交互演示", cancelRace: "任务已开始，当前无法取消；正在继续查询。",
    historyTitle: "我的场景图", historyHint: "最近 20 张记在这台浏览器里，并标明扣除或退回的积分。网关没有“我的任务”列表，换了设备这里看不到。", historyEmpty: "还没有场景图。生成完成后会出现在这里。",
    creditsFree: "未扣积分", creditsCharged: (n: number) => `已扣 ${n} 积分`, creditsRefunded: (n: number) => `已退回 ${n} 积分`, creditsReserved: (n: number) => `已预留 ${n} 积分`,
    historyDownload: "下载原图", historyView: "查看",
  },
  en: {
    title: "Product scenes · Internal test", intro: "Upload your product, extract the subject, then create one scene image.",
    notice: "Internal API mode for test accounts, with no credits used. GPU execution and product quality still require acceptance testing. Progress follows actual job states.",
    connecting: "Checking internal access", ready: "Service connected", upload: "Upload and extract subject", uploadHint: "PNG / JPG / WebP, up to 10 MB and 4096 pixels per side.",
    uploading: "Uploading and confirming the asset", queued: "Job queued", segment: "Extracting the subject", product: "Generating the scene", verifying: "Validating and saving the result",
    starting: "Starting the GPU. Your job is queued and may take a few minutes.", reconnecting: "The connection dropped. Checking again — the result will show up on its own.",
    queueExpired: "The queue wait expired. Reserved credits were refunded. Assets are kept; you can start again.",
    coldGpu: "The GPU node is not running yet. You can still upload and generate: the job stays queued and starts once the node is up, which can take a few minutes.", unknownGpu: "The GPU status could not be checked. Submitting still works: the job stays queued and starts when the node is ready.",
    done: "Job completed", cancelled: "Queued job cancelled", failed: "Processing did not finish. You can start a new job.", refunded: (n: number) => `Not completed. ${n} credits refunded.`, timeout: "This has taken more than 35 minutes. Checking continues in the background. Credits are charged only after success.", missing_output: "The job finished, but the image is not attached yet. The list below keeps checking.", generate: "Generate AI scene", waiting: "Waiting for the active job",
    insufficient: "Insufficient credits. No new job was created.", quoteExpired: "The quote expired. Request a new quote.", paused: "New jobs are paused. Existing jobs can still finish and settle.",
    access: "This account is not in the test cohort. Switch to an authorized MiaoCut account.",
    error: "The connection or operation did not finish. Existing job records are kept; resume to check their status.", login: "Sign in with your existing MiaoCut account. A deployment on the main site’s origin reuses its session.",
    account: "Go to account login", resume: "Resume status checks", cancel: "Cancel queued job", noSubject: "Uploading starts subject extraction automatically.", sourceSaved: "Source saved; generation reuses this asset.",
    reuse: "Change scenes without uploading the product again.", extract: "Extract subject again", viewResult: "View completed result", draft: "Continue composing", noResult: "A completed image will be available to view and download here.",
    candidates: "Generate 4 candidates", candidateOffer: (u: number, n: number, each: number, a: number) => `Up to ${u} credits (${n} × ${each}) · ${a} available`,
    candidateRule: "Credits are reserved one image at a time and charged only for completed images. Your balance must cover the full budget to start.", candidateConfirm: (u: number) => `Confirm · up to ${u} credits`,
    candidateBusy: "Candidates in progress", previewing: (n: number) => `Candidate ${n}`, backToDraft: "Back to draft", choose: "Use this version", downloadCandidate: "Download this one",
    makePoster: "Make a poster", makeRecolor: "Exact recolour",
    loadingImage: "Loading the image", imageFailed: "The image did not load (slow or interrupted connection; it was retried automatically). The job itself is not affected; you can load it again.", retryImage: "Load the image again",
    storage: "The browser cannot save job records. Restore storage access and try again.", expired: "The asset or result is unavailable. Upload the product again; old jobs will not restart automatically.", mode: "Internal test · No credits", returnDemo: "Back to interactive demo", cancelRace: "The job has started and can no longer be cancelled. Status checks continue.",
    historyTitle: "Your scene images", historyHint: "The latest 20 stay in this browser, with the credits charged or refunded. The gateway has no job list, so another device will not see them.", historyEmpty: "No scene images yet. Finished ones appear here.",
    creditsFree: "No credits charged", creditsCharged: (n: number) => `${n} credits charged`, creditsRefunded: (n: number) => `${n} credits refunded`, creditsReserved: (n: number) => `${n} credits reserved`,
    historyDownload: "Download original", historyView: "View",
  },
};
const sceneClasses = { marble: "scene-marble", wood: "scene-wood", geometry: "scene-geometry" };
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function InternalWorkbench({ sessionKey }: { sessionKey: string }) {
  const router = useRouter(), api = useMemo(() => new WorkbenchService(sessionKey), [sessionKey]);
  const storageKey = `mc.workbench.internal.v1.${sessionKey}`;
  const [record, setRecord] = useState<InternalDraft>({ version: 1, document: emptyWorkspace().document, view: "draft" });
  const current = useRef(record), uploadLock = useRef(false);
  const [connected, setConnected] = useState(false), [locale, setLocale] = useState<Locale>("zh"), [dark, setDark] = useState(false);
  const [error, setError] = useState<"login" | "access" | "error" | "storage" | "failed" | "queueExpired" | "expired" | "cancelRace" | "insufficient" | "quoteExpired" | "paused" | "imageFailed" | "timeout" | "missing_output" | null>(null);
  const [phase, setPhase] = useState<ScenePhase | null>(null);
  const [serverJob, setServerJob] = useState<ServiceJob | null>(null), [resume, setResume] = useState(0);
  // 图片下载进度（按资产编号：已下载字节、总字节）和“重新载入图片”的计数；下载器本身见 domain/asset-loader.ts。
  const [imageLoads, setImageLoads] = useState<Record<string, [number, number]>>({}), [imageRetry, setImageRetry] = useState(0);
  const trackImage = useCallback((id: string) => (loaded: number, total: number) => setImageLoads(all => ({ ...all, [id]: [loaded, total] })), []);
  const finishImage = useCallback((id: string) => setImageLoads(all => { if (!(id in all)) return all; const rest = { ...all }; delete rest[id]; return rest; }), []);
  const imageTotal = Object.values(imageLoads).reduce((sum, [, total]) => sum + total, 0);
  const imagePercent = imageTotal > 0 ? Math.min(99, Math.floor(Object.values(imageLoads).reduce((sum, [loaded]) => sum + loaded, 0) / imageTotal * 100)) : Object.keys(imageLoads).length ? 0 : null;
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [asset, setAsset] = useState<LocalAsset>(), [result, setResult] = useState<LocalAsset>();
  const [execution,setExecution]=useState<ServiceExecution['status']>('unknown');
  const [savedForeground,setSavedForeground]=useState<LocalAsset>();
  const [pricing,setPricing]=useState<{segment:number;product:number;admissionOpen:boolean}>();
  const [offer,setOffer]=useState<ServiceQuote>(),[quoting,setQuoting]=useState(false);
  const quoteLock=useRef(false);
  // 四候选：报价面板、服务端组视图、已下载的候选图（按资产 ID）、正在预览的候选序号。
  const [candidatesEnabled,setCandidatesEnabled]=useState(false),[groupOffer,setGroupOffer]=useState<ServiceGroupQuote>();
  const [groupView,setGroupView]=useState<ServiceGroup|null>(null),[candidateImages,setCandidateImages]=useState<Record<string,LocalAsset>>({});
  const [preview,setPreview]=useState<number|null>(null),[groupBusy,setGroupBusy]=useState(false),[groupPoll,setGroupPoll]=useState(0);
  const [historyImages, setHistoryImages] = useState<Record<string, LocalAsset>>({}), [historyTick, setHistoryTick] = useState(0);
  const loadingImages=useRef(new Set<string>());
  const knownAssets = useRef(new Map<string, ServiceAsset>());
  const input = useRef<HTMLInputElement>(null);
  const t = messages[locale], c = copy[locale];
  const replace = useCallback((next: InternalDraft) => {
    if (!next.authUserId) throw new ServiceError("login_required", 401);
    try { localStorage.setItem(`${storageKey}.${next.authUserId}`, JSON.stringify(next)); }
    catch { throw new ServiceError("storage_error"); }
    current.current = next; setRecord(next);
  }, [storageKey]);
  const report = useCallback((problem: unknown) => {
    setError(problem instanceof ServiceError && problem.status === 401 ? "login" :
      problem instanceof ServiceError && ["asset_download_failed", "asset_timeout", "asset_mismatch"].includes(problem.code) ? "imageFailed" :
      problem instanceof ServiceError && problem.code==='internal_access_required'?'access':
      problem instanceof ServiceError && problem.code==='billing_paused'?'paused':
      problem instanceof ServiceError && problem.code==='quote_expired'?'quoteExpired':
      problem instanceof ServiceError && problem.code==='insufficient'?'insufficient':
      problem instanceof ServiceError && problem.code === "storage_error" ? "storage" : "error");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      setConnected(false); setPhase(null);
      setAsset(undefined); setResult(undefined);setServerJob(null);setOffer(undefined); setHistoryImages({});
      setGroupOffer(undefined);setGroupView(null);setCandidateImages({});setPreview(null);loadingImages.current.clear(); knownAssets.current.clear();
      setDark(document.documentElement.classList.contains("dark"));
      try { setLocale(localStorage.getItem("mc.workbench.locale") === "en" ? "en" : "zh"); } catch { /* Optional. */ }
      try {
        const caps = await api.call<{ mode: string; version: number; identity?: { authUserId: string }; execution?:ServiceExecution; candidates?:{counts?:number[]}|null; billing?: { mode: string; units?: number;segment?:number;product?:number;admissionOpen?:boolean } }>("capabilities", undefined, controller.signal);
        const identity = caps.identity?.authUserId;
        const paid=caps.version===2&&caps.billing?.mode==='credits_internal'&&[caps.billing.segment,caps.billing.product].every(n=>Number.isSafeInteger(n)&&n!>=0);
        if (caps.mode !== "internal" || (!(caps.version===1&&caps.billing?.mode==='unbilled_internal'&&caps.billing.units===0)&&!paid) || !identity || !/^[0-9a-f-]{36}$/i.test(identity)) throw new ServiceError("protocol_mismatch");
        if(!controller.signal.aborted)setPricing(paid?{segment:caps.billing!.segment!,product:caps.billing!.product!,admissionOpen:caps.billing!.admissionOpen===true}:undefined);
        // 候选组依赖积分账本里的组预算；不计费模式下服务端不开放，页面也不显示入口。
        if(!controller.signal.aborted)setCandidatesEnabled(paid&&Array.isArray(caps.candidates?.counts)&&caps.candidates!.counts!.includes(CANDIDATE_COUNT));
        if(!controller.signal.aborted)setExecution(caps.execution?.status==='online'?'online':caps.execution?.status==='offline'?'offline':'unknown');
        let draft: InternalDraft = { version: 1, authUserId: identity, document: emptyWorkspace(crypto.randomUUID()).document, view: "draft" };
        try {
          const saved = JSON.parse(localStorage.getItem(`${storageKey}.${identity}`) || "null");
          if (validInternalDraft(saved) && saved.authUserId === identity) draft = { ...saved, history: sceneHistory(saved.history) };
        } catch { /* Corrupt local records never become service requests. */ }
        if (!controller.signal.aborted) { current.current = draft; setRecord(draft); setConnected(true); setError(null); }
      } catch (e) { if (!controller.signal.aborted) report(e); }
    }
    void initialize(); return () => controller.abort();
  }, [api, storageKey, report, resume]);

  useEffect(()=>{
    if(!connected)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const caps=await api.call<{execution?:ServiceExecution}>('capabilities',undefined,controller.signal);
        if(!controller.signal.aborted)setExecution(caps.execution?.status==='online'?'online':caps.execution?.status==='offline'?'offline':'unknown');
      } catch {if(!controller.signal.aborted)setExecution('unknown');}
      if(!controller.signal.aborted)timer=setTimeout(()=>void refresh(),15000);
    }
    timer=setTimeout(()=>void refresh(),15000);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[api,connected]);

  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === sessionKey) setResume(n => n + 1); };
    window.addEventListener("storage", changed);
    const authChanged=()=>setResume(n=>n+1);window.addEventListener('mc.workbench-auth',authChanged);
    return () => {window.removeEventListener("storage", changed);window.removeEventListener('mc.workbench-auth',authChanged);};
  }, [sessionKey]);

  const pending = record.pending;
  useEffect(() => {
    if (!pending || !connected) return;
    const controller = new AbortController(), signal = controller.signal;
    const jobRequest = pending.request;
    const quoteId = pending.quoteId;
    const requestId = jobRequest.requestId;
    const same = () => current.current.pending?.request.requestId === requestId;
    const startedAt = Number.isFinite(pending.startedAt) ? pending.startedAt! : Date.now();
    let missingOutputs = 0, failures = 0;
    const note = (job: ServiceJob) => {
      if (job.outputs?.final) knownAssets.current.set(job.outputs.final.assetId, job.outputs.final);
      if (job.outputs?.foreground) knownAssets.current.set(job.outputs.foreground.assetId, job.outputs.foreground);
      const entry = historyFromJob(job, startedAt);
      const prev = sceneHistory(current.current.history).find(row => row.jobId === job.jobId);
      const history = entry && (!prev || prev.state !== entry.state || prev.billing !== entry.billing || prev.units !== entry.units || prev.resultAssetId !== entry.resultAssetId || prev.error !== entry.error)
        ? rememberSceneJob(current.current.history, entry) : current.current.history;
      return history;
    };
    const expireAssets = () => {
      try {
        replace({ ...current.current, pending: undefined, view: "draft", document: { ...current.current.document,
          revision: current.current.document.revision + 1, sourceAssetId: null, foregroundAssetId: undefined } });
        setError("expired");
      } catch (storageError) { report(storageError); }
    };
    const rejectCreate = (e: unknown) => {
      const code = e instanceof ServiceError ? e.code : "";
      try { replace({ ...current.current, pending: undefined }); setError(code === "insufficient" ? "insufficient" : code === "quote_expired" ? "quoteExpired" : code === "billing_paused" ? "paused" : "failed"); }
      catch (storageError) { report(storageError); }
    };
    const finish = (job: ServiceJob, step: ReturnType<typeof scenePollStep>) => {
      const next = current.current, history = note(job);
      setServerJob(job); setPhase(step.phase);
      if (step.phase === "succeeded" && step.resultAssetId) {
        if (jobRequest.kind === "segment") {
          const foreground = job.outputs?.foreground;
          if (!foreground) return false;
          replace({ ...next, history, pending: undefined, view: "draft", document: { ...next.document,
            revision: next.document.revision + 1, foregroundAssetId: foreground.assetId, placement: fitPlacement(foreground) } });
        } else {
          const r = jobRequest;
          const snapshot: ProductDocument = { id: r.documentId, revision: r.documentRevision, sourceAssetId: r.sourceAssetId,
            foregroundAssetId: r.foregroundAssetId, scene: r.scene!, canvas: r.canvas!, placement: r.placement! };
          replace({ ...next, history, pending: undefined, result: { assetId: step.resultAssetId, document: snapshot },
            view: next.document.revision === r.documentRevision ? "result" : "draft" });
        }
        setError(null); return true;
      }
      if (step.phase === "missing_output") { replace({ ...next, history, pending: undefined }); setError("missing_output"); return true; }
      if (step.phase === "timeout") return false;
      replace({ ...next, history, pending: undefined });
      setError(step.phase === "expired" ? "queueExpired" : step.phase === "cancelled" || step.phase === "refunded" ? null : "failed");
      return true;
    };
    async function track() {
      const jobId = current.current.pending?.jobId;
      if (!jobId) {
        while (!signal.aborted && same()) {
          try {
            const created = await api.create(jobRequest, signal, quoteId);
            if (signal.aborted || !same()) return;
            const createdStep = scenePollStep({ job: created, kind: jobRequest.kind, startedAt, now: Date.now(), missingOutputs: 0 });
            // 创建响应本身可能已经是终态（幂等重放）。先收尾，不要丢掉这次带结果的响应再等下一次查询。
            if (!createdStep.poll) { finish(created, createdStep); return; }
            replace({ ...current.current, pending: { ...current.current.pending!, jobId: created.jobId, startedAt }, history: note(created) });
            setServerJob(created); setPhase(createdStep.phase); setError(null); return;
          } catch (e) {
            if (signal.aborted || !same()) return;
            if (e instanceof ServiceError && e.code === "storage_error") { report(e); return; }
            const action = scenePollErrorAction(e instanceof ServiceError ? { code: e.code, status: e.status } : null, false);
            if (action === "expired_asset") { expireAssets(); return; }
            if (action === "reject") { if (e instanceof ServiceError && e.status === 401) report(e); else rejectCreate(e); return; }
            failures++; setPhase("reconnecting");
            await sleep(pollBackoffMs(failures), signal).catch(() => undefined);
          }
        }
        return;
      }
      while (!signal.aborted && same()) {
        try {
          const job = await api.job(jobId, signal);
          if (signal.aborted || !same()) return;
          failures = 0; setServerJob(job);
          const step = scenePollStep({ job, kind: jobRequest.kind, startedAt, now: Date.now(), missingOutputs });
          if (job.state === "succeeded" && !step.resultAssetId) missingOutputs += 1; else missingOutputs = 0;
          setPhase(step.phase);
          const history = note(job);
          if (history !== current.current.history) replace({ ...current.current, history });
          if (!step.poll) { finish(job, step); return; }
          setError(null);
          await sleep(step.delayMs, signal);
        } catch (e) {
          if (signal.aborted || !same()) return;
          if (e instanceof ServiceError && e.code === "storage_error") { report(e); return; }
          const action = scenePollErrorAction(e instanceof ServiceError ? { code: e.code, status: e.status } : null, true);
          if (action === "expired_asset") { expireAssets(); return; }
          if (action === "reject") { report(e); return; }
          // 查询中途断一下不停：服务端完成后下一次查询会把图接上，不用刷新。
          failures++; setPhase("reconnecting");
          await sleep(pollBackoffMs(failures), signal).catch(() => undefined);
        }
      }
    }
    void track(); return () => controller.abort();
  }, [pending, api, connected, replace, report, resume]);

  const groupRecord = record.group;
  useEffect(() => {
    if (!groupRecord || !connected) return;
    const controller = new AbortController(), signal = controller.signal;
    const same = () => current.current.group?.groupId === groupRecord.groupId;
    async function track() {
      try {
        if (!groupRecord!.confirmed) {
          // 确认请求按 groupId + 请求内容幂等：确认响应丢失或刷新后重发，服务端返回同一个组，不会再冻结积分。
          const view = await api.createGroup(groupRecord!.groupId, groupRecord!.request, signal);
          if (signal.aborted || !same()) return;
          if (!groupMatches(view, groupRecord!)) throw new ServiceError("protocol_mismatch");
          setGroupView(view); replace({ ...current.current, group: { ...groupRecord!, confirmed: true } }); return;
        }
        let failures = 0;
        while (!signal.aborted && same()) {
          try {
            const view = await api.group(groupRecord!.groupId, signal);
            if (signal.aborted || !same()) return;
            if (!groupMatches(view, groupRecord!)) throw new ServiceError("protocol_mismatch");
            failures = 0;
            setGroupView(view);
            // 没有执行中的候选且组不会自己推进（完成、停止、等待积分）时停止轮询；继续或停止操作会重新开始。
            if (!groupActive(view)) return;
          } catch (e) {
            if (signal.aborted) return;
            const code = e instanceof ServiceError ? e.code : "";
            if (code === "group_not_found" && same()) {
              try { replace({ ...current.current, group: undefined }); setGroupView(null); setPreview(null); } catch (storageError) { report(storageError); }
              return;
            }
            if (code === "protocol_mismatch" || (e instanceof ServiceError && (e.status === 401 || e.status === 403))) { report(e); return; }
            failures++;
          }
          await sleep(failures ? pollBackoffMs(failures) : 2000, signal).catch(() => undefined);
        }
      } catch (e) {
        if (signal.aborted) return;
        const code = e instanceof ServiceError ? e.code : "";
        if (!groupRecord!.confirmed && ["quote_expired", "quote_changed", "quote_not_found", "insufficient", "billing_paused", "invalid_fields", "invalid_group", "group_count"].includes(code) && same()) {
          // 确认没有成功，不存在任何冻结：丢弃这条记录，让用户重新报价。
          try { replace({ ...current.current, group: undefined }); setGroupView(null); setPreview(null); setError(code === "insufficient" ? "insufficient" : code === "quote_expired" ? "quoteExpired" : code === "billing_paused" ? "paused" : "failed"); }
          catch (storageError) { report(storageError); }
        } else if (code === "group_not_found" && same()) {
          try { replace({ ...current.current, group: undefined }); setGroupView(null); setPreview(null); } catch (storageError) { report(storageError); }
        } else report(e);
      }
    }
    void track(); return () => controller.abort();
  }, [groupRecord, api, connected, replace, report, resume, groupPoll]);
  // 候选图用预览。组状态每 2 秒换一个新对象，不能因此把正在下的图掐掉（那会让成功之后一直转圈，直到刷新）。
  const candidateAssets = useMemo(() => groupView?.items.flatMap(item => item.result ? [item.result] : []) ?? [], [groupView]);
  const candidateRef = useRef(candidateAssets);
  useEffect(() => { candidateRef.current = candidateAssets; }, [candidateAssets]);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const pump = () => {
      if (controller.signal.aborted) return;
      for (const result of candidateRef.current) {
        if (loadingImages.current.has(result.assetId)) continue;
        loadingImages.current.add(result.assetId);
        void api.preview(result, controller.signal).then(image => {
          if (!controller.signal.aborted) setCandidateImages(images => ({ ...images, [result.assetId]: image }));
        }).catch(() => { loadingImages.current.delete(result.assetId); });
      }
      timer = setTimeout(pump, 3_000);
    };
    pump();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, connected]);

  const loadShown = useCallback(async (id: string, signal: AbortSignal, onProgress?: (loaded: number, total: number) => void) => {
    const known = knownAssets.current.get(id);
    const fresh = async () => { const asset = await api.asset(id, signal); knownAssets.current.set(id, asset); return api.preview(asset, signal, onProgress); };
    try { return await api.preview(known ?? await api.asset(id, signal).then(asset => { knownAssets.current.set(id, asset); return asset; }), signal, onProgress); }
    catch (error) {
      if (signal.aborted || !known) throw error;
      knownAssets.current.delete(id);
      return fresh();
    }
  }, [api]);
  const displayAssetId = record.document.foregroundAssetId || record.document.sourceAssetId;
  useEffect(() => {
    if (!connected || !displayAssetId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, attempt = 0;
    const run = () => {
      void loadShown(displayAssetId, controller.signal, trackImage(displayAssetId)).then(image => {
        finishImage(displayAssetId);
        if (!controller.signal.aborted) setAsset(image);
      }).catch(e => {
        finishImage(displayAssetId);
        if (controller.signal.aborted) return;
        if (attempt < 3) { attempt++; timer = setTimeout(run, 1000 * attempt); return; }
        report(e);
      });
    };
    run();
    return () => { controller.abort(); clearTimeout(timer); finishImage(displayAssetId); };
  }, [api, displayAssetId, connected, report, imageRetry, trackImage, finishImage, loadShown]);
  const resultId = record.result?.assetId;
  useEffect(() => {
    if (!connected || !resultId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, attempt = 0;
    const run = () => {
      void loadShown(resultId, controller.signal, trackImage(resultId)).then(image => {
        finishImage(resultId);
        if (!controller.signal.aborted) setResult(image);
      }).catch(e => {
        finishImage(resultId);
        if (controller.signal.aborted) return;
        if (attempt < 3) { attempt++; timer = setTimeout(run, 1000 * attempt); return; }
        report(e);
      });
    };
    run();
    return () => { controller.abort(); clearTimeout(timer); finishImage(resultId); };
  }, [api, resultId, connected, report, imageRetry, trackImage, finishImage, loadShown]);

  const comparisonDocument=record.result?.document||record.document;
  const comparisonId=comparisonDocument.foregroundAssetId;
  useEffect(()=>{
    if(!connected||!comparisonId||asset?.id===comparisonId)return;
    const controller=new AbortController();
    void api.asset(comparisonId,controller.signal).then(a=>api.preview(a,controller.signal,trackImage(comparisonId))).then(a=>{
      finishImage(comparisonId);
      if(!controller.signal.aborted)setSavedForeground(a);
    }).catch(e=>{finishImage(comparisonId);if(!controller.signal.aborted)report(e);});
    return ()=>{controller.abort();finishImage(comparisonId);};
  },[api,connected,comparisonId,asset,report,imageRetry,trackImage,finishImage]);

  // 当前这张以外的场景任务：进行中的、或成功了但图还没到的，自己再问。不和上面的主轮询抢同一张。
  const historyWatch = sceneHistory(record.history).filter(row => (row.state === "queued" || row.state === "leased" || row.state === "verifying" || row.state === "settling" || (row.state === "succeeded" && !row.resultAssetId)) && row.jobId !== pending?.jobId).map(row => row.jobId).join(",");
  useEffect(() => {
    if (!connected || !historyWatch) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const ids = historyWatch.split(",").filter(id => {
        const row = sceneHistory(current.current.history).find(item => item.jobId === id);
        return !!row && historyNeedsPoll(row, Date.now());
      });
      if (ids.length === 0) return;
      for (const id of ids) {
        if (controller.signal.aborted) return;
        const row = sceneHistory(current.current.history).find(item => item.jobId === id);
        if (!row || !historyNeedsPoll(row, Date.now())) continue;
        try {
          const job = await api.job(id, controller.signal);
          if (controller.signal.aborted) return;
          const entry = historyFromJob(job, row.createdAt);
          if (!entry) continue;
          const prev = sceneHistory(current.current.history).find(item => item.jobId === id);
          if (prev && prev.state === entry.state && prev.billing === entry.billing && prev.units === entry.units && prev.resultAssetId === entry.resultAssetId && prev.error === entry.error) continue;
          const history = rememberSceneJob(current.current.history, entry);
          const show = entry.resultAssetId && !current.current.pending && (!current.current.result || current.current.result.assetId === entry.resultAssetId);
          replace(show ? { ...current.current, history, result: { assetId: entry.resultAssetId!, document: entry.document }, view: current.current.document.revision === entry.document.revision ? "result" : current.current.view } : { ...current.current, history });
          if (job.outputs?.final) knownAssets.current.set(job.outputs.final.assetId, job.outputs.final);
        } catch { /* 下一轮再试。登录失效由主轮询提示。 */ }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), 4_000);
    };
    void tick();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, connected, historyWatch, historyTick, replace]);
  const historyRows = sceneHistory(record.history);
  const historyRef = useRef(historyRows);
  useEffect(() => { historyRef.current = historyRows; }, [historyRows]);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const inflight = new Set<string>(), done = new Set<string>();
    let timer: ReturnType<typeof setTimeout>;
    const pump = () => {
      if (controller.signal.aborted) return;
      for (const row of historyRef.current) {
        const id = row.resultAssetId;
        if (!id || done.has(id) || inflight.has(id)) continue;
        inflight.add(id);
        void loadShown(id, controller.signal).then(image => {
          inflight.delete(id);
          if (controller.signal.aborted) return;
          done.add(id);
          setHistoryImages(all => ({ ...all, [id]: image }));
        }).catch(() => { inflight.delete(id); });
      }
      timer = setTimeout(pump, 4_000);
    };
    pump();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, connected, loadShown]);

  const edit = (patch: Partial<ProductDocument>) => {
    if (!connected) return;
    setOffer(undefined); setGroupOffer(undefined); setPreview(null);
    try { replace({ ...current.current, view: "draft", document: { ...current.current.document, ...patch, revision: current.current.document.revision + 1 } }); }
    catch (e) { report(e); }
  };
  const uploadFile = async (file: File) => {
    if (uploadLock.current || current.current.pending || !connected || !sceneSubmitAllowed(pricing?.admissionOpen)) return;
    const actingUser = current.current.authUserId;
    uploadLock.current = true; setUploadProgress(0); setError(null);
    try {
      const source = await api.upload(file, setUploadProgress), before = current.current;
      if (before.authUserId !== actingUser) return;
      const document = { ...before.document, revision: before.document.revision + 1, sourceAssetId: source.assetId, foregroundAssetId: undefined };
      replace({ ...before, document, view: "draft" });
      await generate('segment');
    } catch (e) { report(e); }
    finally { uploadLock.current = false; setUploadProgress(null); }
  };
  const generate = async (kind: "product" | "segment") => {
    const state = current.current, doc = state.document;
    if (!sceneSubmitAllowed(pricing?.admissionOpen)) { setError("paused"); return; }
    if (!connected || state.pending || quoteLock.current || !doc.sourceAssetId || (kind === "product" && !doc.foregroundAssetId)) return;
    const request: ServiceJobRequest = { version: 1, requestId: crypto.randomUUID(), kind, documentId: doc.id,
      documentRevision: doc.revision, sourceAssetId: doc.sourceAssetId,
      ...(kind === "product" ? { foregroundAssetId: doc.foregroundAssetId, scene: doc.scene, canvas: doc.canvas, placement: doc.placement } : {}) };
    quoteLock.current=true;setQuoting(true);
    try {
      if(pricing) {
        const quote=await api.quote(request);
        if(current.current.authUserId!==state.authUserId||current.current.document.revision!==doc.revision)return;
        if(!Number.isSafeInteger(quote.units)||quote.units<0||quote.expiresAt<=Date.now())throw new ServiceError('invalid_quote');
        if(quote.units>0)setOffer(quote);
        else replace({...current.current,view:'draft',pending:{request,quoteId:quote.quoteId,startedAt:Date.now()}});
      } else replace({ ...state, view: "draft", pending: { request, startedAt: Date.now() } });
      setError(null); setPhase(null);
    }
    catch (e) { report(e); }
    finally {quoteLock.current=false;setQuoting(false);}
  };
  const acceptOffer=()=>{
    if (!sceneSubmitAllowed(pricing?.admissionOpen)) { setError("paused"); return; }
    if(!offer||current.current.pending||!connected)return;
    if(offer.expiresAt<=Date.now()){setOffer(undefined);setError('quoteExpired');return;}
    try {replace({...current.current,view:'draft',pending:{request:offer.request,quoteId:offer.quoteId,startedAt:Date.now()}});setOffer(undefined);setError(null);setPhase(null);}
    catch(e){report(e);}
  };
  const cancel = async () => {
    const active = current.current.pending; if (!active?.jobId) return;
    try {
      const job = await api.cancel(active.jobId);
      if (current.current.pending?.request.requestId === active.request.requestId) {
        if(['failed','cancelled'].includes(job.state))replace({ ...current.current, pending: undefined });
        setServerJob(job);
      }
    } catch (e) { if (e instanceof ServiceError && e.code === "cannot_cancel_running") setError("cancelRace"); else report(e); }
  };
  // 页面上显示的图可能是服务端的缩小预览（WebP，只用于显示，见 domain/preview.ts）。下载、做海报、换色必须用原始 PNG：
  // 这里按资产编号取回原图（向服务端要新的下载链接；浏览器里已经有就直接命中缓存），再交给对应的动作。
  // 取回期间禁用这几个按钮，进度显示在状态行（“正在载入图片 · N%”）；失败走统一的错误提示。
  const [exporting, setExporting] = useState(false);
  const fetchOriginal = useCallback(async (assetId: string): Promise<LocalAsset> => {
    const key = `${assetId}:original`;
    try {
      const original = await api.asset(assetId);
      return await api.image(original, undefined, trackImage(key));
    } finally { finishImage(key); }
  }, [api, trackImage, finishImage]);
  const exportOriginal = async (assetId: string, action: (blob: Blob) => void | Promise<void>) => {
    if (exporting) return;
    setExporting(true);
    try { await action((await fetchOriginal(assetId)).blob); } catch (e) { report(e); } finally { setExporting(false); }
  };
  // 把结果图交给海报页：先存进同源 IndexedDB 的待取区，再跳转。海报页只替换背景，不改已有文字。
  const makePoster = async (blob: Blob | undefined, name: string) => {
    if (!blob) return;
    try { await writeHandoff(blob, name); router.push("/poster"); } // basePath（/workbench）由路由自动补上
    catch { setError("storage"); }
  };
  // 把结果图交给换色页：同样先存进同源 IndexedDB 的待取区，再跳转。换色页把它当作新底图，旧的涂抹作废。
  const makeRecolor = async (blob: Blob | undefined, name: string) => {
    if (!blob) return;
    try { await writeRecolorHandoff(blob, name); router.push("/recolor"); }
    catch { setError("storage"); }
  };
  const candidatesBusy = !!groupRecord && (!groupRecord.confirmed || (!!groupView && groupActive(groupView)));
  const generateCandidates = async () => {
    const state = current.current, doc = state.document;
    if (!sceneSubmitAllowed(pricing?.admissionOpen)) { setError("paused"); return; }
    if (!connected || !pricing || !candidatesEnabled || quoteLock.current || candidatesBusy) return;
    const request = candidateRequest(doc, crypto.randomUUID()); if (!request) return;
    quoteLock.current = true; setQuoting(true);
    try {
      const quote = await api.groupQuote(request);
      if (current.current.authUserId !== state.authUserId || current.current.document.revision !== doc.revision) return;
      if (!Number.isSafeInteger(quote.units) || quote.units < 0 || quote.expiresAt <= Date.now() || quote.request.requestId !== request.requestId || !/^[0-9a-f-]{36}$/i.test(quote.groupId)) throw new ServiceError("invalid_quote");
      setOffer(undefined); setGroupOffer(quote); setError(null);
    } catch (e) { report(e); }
    finally { quoteLock.current = false; setQuoting(false); }
  };
  const acceptGroupOffer = () => {
    if (!sceneSubmitAllowed(pricing?.admissionOpen)) { setError("paused"); return; }
    if (!groupOffer || !connected || candidatesBusy) return;
    if (groupOffer.expiresAt <= Date.now()) { setGroupOffer(undefined); setError("quoteExpired"); return; }
    // 先持久化 groupId 再提交确认：确认响应丢失时，刷新后用同一个 groupId 继续，不会建第二组。
    try {
      replace({ ...current.current, group: { groupId: groupOffer.groupId, request: groupOffer.request } });
      // 新的一组开始：清掉上一组的预览和已下载的候选图，释放内存。
      setGroupOffer(undefined); setGroupView(null); setPreview(null); setCandidateImages({}); loadingImages.current.clear(); setError(null);
    }
    catch (e) { report(e); }
  };
  const groupAction = async (action: "stop" | "resume") => {
    const active = current.current.group; if (!active?.confirmed || groupBusy) return;
    setGroupBusy(true);
    try {
      const view = action === "stop" ? await api.cancelGroup(active.groupId) : await api.resumeGroup(active.groupId);
      if (current.current.group?.groupId === active.groupId && groupMatches(view, active)) { setGroupView(view); setGroupPoll(n => n + 1); }
    } catch (e) { report(e); }
    finally { setGroupBusy(false); }
  };
  const previewItem = preview !== null && groupView && groupRecord && groupMatches(groupView, groupRecord) ? groupView.items[preview] : undefined;
  const previewImage = previewItem?.result ? candidateImages[previewItem.result.assetId] : undefined;
  const chooseCandidate = () => {
    const active = current.current.group;
    if (!active || !previewItem?.result) return;
    try { replace({ ...current.current, result: { assetId: previewItem.result.assetId, document: candidateSnapshot(active.request) }, view: "result" }); setPreview(null); }
    catch (e) { report(e); }
  };
  const readonly = record.view === "result" && !!record.result;
  const currentJob = pending?.jobId === serverJob?.jobId ? serverJob : null;
  const billing=(pending?currentJob:serverJob)?.billing;
  const billingMessage=billing?.mode==='credits_internal'?(billing.units===0?(locale==='zh'?'主体提取免费':'Free extraction'):
    billing.state==='confirmed'?(locale==='zh'?`已扣除 ${billing.units} 积分`:`${billing.units} credits charged`):
    billing.state==='released'?(billing.units>0?(locale==='zh'?`已退回 ${billing.units} 积分`:`${billing.units} credits refunded`):(locale==='zh'?'未扣积分':'No credits charged')):
    (locale==='zh'?`已预留 ${billing.units} 积分`:`${billing.units} credits reserved`)):null;
  const visibleAsset = connected && asset?.id === displayAssetId ? asset : undefined;
  const output = connected && result?.id === resultId ? result : undefined;
  const displayDocument = readonly ? record.result!.document : record.document;
  const limits = visibleAsset ? sizeLimits(visibleAsset) : { min: .2, max: .92 };
  const phaseText = !phase ? null : phase === "starting" ? c.starting : phase === "reconnecting" ? c.reconnecting : phase === "queued" ? c.queued
    : phase === "running" ? (pending?.request.kind === "segment" ? c.segment : c.product) : phase === "verifying" ? c.verifying
    : phase === "settling" ? (locale === "zh" ? "正在确认积分结算" : "Confirming credit settlement") : phase === "succeeded" ? c.done
    : phase === "refunded" ? c.refunded(billing?.mode === "credits_internal" ? billing.units : 0) : phase === "cancelled" ? c.cancelled
    : phase === "expired" ? c.queueExpired : phase === "timeout" ? c.timeout : phase === "missing_output" ? c.missing_output : phase === "failed" ? c.failed : null;
  const status = uploadProgress !== null ? `${c.uploading} · ${uploadProgress}%` : imagePercent !== null && !pending ? `${c.loadingImage} · ${imagePercent}%`
    : phaseText ?? (pending ? (pending.request.kind === "segment" ? c.segment : c.queued) : connected ? c.ready : c.connecting);
  const spinning = uploadProgress !== null || (imagePercent !== null && !pending) || (!!pending && phase !== "timeout");
  const warn = phase === "timeout" || phase === "failed" || phase === "expired" || phase === "missing_output" || phase === "refunded";
  const creditText = (row: SceneHistoryEntry) => { const phrase = creditPhrase(row); return phrase === "charged" ? c.creditsCharged(row.units) : phrase === "refunded" ? c.creditsRefunded(row.units) : phrase === "reserved" ? c.creditsReserved(row.units) : c.creditsFree; };
  const openHistory = (row: SceneHistoryEntry) => {
    if (!row.resultAssetId) return;
    try {
      replace({ ...current.current, result: { assetId: row.resultAssetId, document: row.document }, view: "result" });
      if (!current.current.pending) setPhase("succeeded");
      setError(null);
    } catch (e) { report(e); }
  };
  const move = (placement: Rect) => edit({ placement });
  return <div className="workbench-app internal-workbench">
    <header className="site-header"><div className="header-content"><a className="brand-link" aria-label="MiaoCut" href="https://miaocut.app"><span className="brand-mark"><Scissors size={19} /></span>MiaoCut</a>
      <span className="header-workspace">{pricing?(locale==='zh'?'积分内测':'Credit test'):c.mode}</span><div className="header-actions"><a className="comparison-back" href="/workbench/compare">{locale==='zh'?'查看对比样图':'Compare samples'}</a><a className="header-link" href="/workbench/poster">{locale==='zh'?'做海报':'Poster'}</a><a className="header-link" href="/workbench/recolor">{locale==='zh'?'精确换色':'Recolour'}</a><a className="header-link" href="/workbench/batch">{locale==='zh'?'批量场景':'Batch'}</a><button type="button" className="icon-button" aria-label={t.language} onClick={() => { const next = locale === "zh" ? "en" : "zh"; setLocale(next); document.documentElement.lang = next; }}>{locale === "zh" ? "EN" : "中"}</button>
        <button type="button" className="icon-button" aria-label={dark ? t.switchLight : t.switchDark} onClick={() => { setDark(!dark); document.documentElement.classList.toggle("dark", !dark); }}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button></div></div></header>
    <main className="workspace-main"><div className="page-heading"><div><h1>{c.title}</h1><p>{c.intro}</p></div></div>
      <div className="demo-notice">{pricing?(locale==='zh'?`内测：主体提取 ${pricing.segment} 积分，每张场景图 ${pricing.product} 积分。确认报价后预留积分，完成后扣减。`:`Internal test: extraction ${pricing.segment} credits; each scene ${pricing.product} credits. Credits are reserved after confirmation and charged on completion.`):c.notice}</div>
      {pricing?.admissionOpen===false?<div className="demo-notice" role="status">{c.paused}</div>:null}
      {connected && execution === "offline" ? <div className="demo-notice" role="status">{c.coldGpu}</div> : null}
      {connected && execution === "unknown" ? <div className="demo-notice" role="status">{c.unknownGpu}</div> : null}
      {error ? <div className="error-notice" role="alert"><span>{c[error]}</span>{(error === "login" || error === "access") ? <a href={accountConfigured()?'/workbench/login':"https://miaocut.app/account/"}>{c.account}</a> : <button type="button" className="subtle-button" onClick={() => { setError(null); if (error === "imageFailed") setImageRetry(n => n + 1); else if (error === "missing_output") setHistoryTick(n => n + 1); else setResume(n => n + 1); }}>{error === "imageFailed" ? c.retryImage : c.resume}</button>}</div> : null}
      <div className="workspace-grid"><aside className="side-panel asset-panel"><div className="panel-section"><h2>{t.assetTitle}</h2>
        <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.currentTarget.value = ""; }} />
        <button type="button" className="upload-zone" disabled={!connected || !sceneSubmitAllowed(pricing?.admissionOpen) || !!pending || quoting || uploadProgress !== null} onClick={() => input.current?.click()}>{visibleAsset ? <span className="asset-thumbnail checkerboard"><BlobImage blob={visibleAsset.blob} alt={t.assetTitle} /></span> : <Upload size={24} />}<span>{visibleAsset ? t.replace : c.upload}</span></button><p className="control-help">{c.uploadHint}</p><p className="control-help">{record.document.sourceAssetId ? c.sourceSaved : c.noSubject}</p>
        {record.document.sourceAssetId && !record.document.foregroundAssetId && !pending ? <button type="button" className="sample-button" disabled={quoting||!sceneSubmitAllowed(pricing?.admissionOpen)} onClick={() => void generate("segment")}>{c.extract}</button> : null}
      </div><div className="panel-section scene-section"><h2>{t.sceneTitle}</h2><div className="scene-list">{SCENES.map(scene => <button type="button" key={scene} disabled={!connected} aria-label={t[scene]} aria-pressed={record.document.scene === scene}
        className={`scene-card ${record.document.scene === scene ? "is-selected" : ""}`} onClick={() => edit({ scene })}><span className={`scene-thumbnail ${sceneClasses[scene]}`} /><strong>{t[scene]}</strong></button>)}</div></div></aside>
        <section className="canvas-panel" aria-label={t.canvasLabel}>{previewItem && groupRecord ? <>
          {/* 预览某张候选：只读展示，选定后才成为结果版本；编辑稿保持不变。 */}
          <div className="canvas-toolbar"><span>{c.previewing(previewItem.index + 1)} · {t[candidateSnapshot(groupRecord.request).scene]}</span><button type="button" className="subtle-button" onClick={() => setPreview(null)}>{c.backToDraft}</button></div>
          <div className="canvas-space"><div className="editor-stage completed-stage">{previewImage ? <BlobImage blob={previewImage.blob} alt={c.previewing(previewItem.index + 1)} width={1024} height={1024} /> : <div className="stage-loading">{t.loadingCanvas}</div>}</div></div>
          <div className="canvas-caption">{c.previewing(previewItem.index + 1)}</div></> : <>
          <div className="canvas-toolbar"><span>{readonly ? `${c.viewResult} · ${t[displayDocument.scene]}` : t.draft}</span>{record.result ? <button type="button" className="subtle-button" disabled={!connected || !!pending} onClick={() => { try { replace({ ...current.current, view: readonly ? "draft" : "result" }); } catch(e) { report(e); } }}>{readonly ? c.draft : c.viewResult}</button> : null}</div>
          <div className="canvas-space">{readonly || !displayAssetId ? <div className="editor-stage completed-stage">{readonly && output ? <BlobImage blob={output.blob} alt={c.viewResult} width={1024} height={1024} /> : <div className="stage-loading">{readonly ? t.loadingCanvas : c.noSubject}</div>}</div> : <EditorCanvas document={record.document} asset={visibleAsset} guides={false} onPlacement={move} t={t} />}</div>
          <div className="canvas-caption">{readonly ? c.viewResult : t.canvasHint}</div></>}</section>
        <aside className="side-panel inspector-panel"><div className="panel-section"><h2>{t.composition}</h2><label className="size-label" htmlFor="internal-size">{t.scale}<output>{Math.round(displayDocument.placement.width * 100)}%</output></label>
          <input id="internal-size" type="range" className="size-slider" min={limits.min} max={limits.max} step="0.005" value={record.document.placement.width} disabled={readonly || !visibleAsset || !record.document.foregroundAssetId}
            onChange={e => { if (visibleAsset) move(resizePlacement(record.document.placement, Number(e.target.value), visibleAsset)); }} />
          <button type="button" className="sample-button" disabled={readonly || !visibleAsset} onClick={() => { if (visibleAsset) move(fitPlacement(visibleAsset)); }}>{t.reset}</button><p className="control-help">{c.reuse}</p></div>
          <div className="panel-section output-section"><h2>{t.output}</h2><p className="control-help">1024 × 1024 · PNG</p></div>
          <div className="generate-section">{groupOffer ? <div role="region" aria-label={c.candidates}><p>{c.candidateOffer(groupOffer.units, groupOffer.count, groupOffer.unitUnits, groupOffer.availableCredits)}</p>
            <p className="control-help">{groupOffer.availableCredits < groupOffer.units ? (locale === 'zh' ? '可用积分不足，请前往账户补充积分。' : 'Insufficient credits. Add credits from your account.') : null}</p><p className="control-help">{c.candidateRule}</p>
            <button type="button" className="primary-button" onClick={acceptGroupOffer} disabled={!sceneSubmitAllowed(pricing?.admissionOpen) || groupOffer.availableCredits < groupOffer.units}>{c.candidateConfirm(groupOffer.units)}</button>
            <button type="button" className="sample-button" onClick={() => setGroupOffer(undefined)}>{locale === 'zh' ? '返回编辑' : 'Back to editing'}</button></div> :
            previewItem?.result ? <div role="region" aria-label={c.previewing(previewItem.index + 1)}><button type="button" className="primary-button" onClick={chooseCandidate}><Check size={17} />{c.choose}</button>
            <button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportOriginal(previewItem.result!.assetId, blob => downloadPng(blob, `miaocut-candidate-${previewItem.index + 1}-${previewItem.result!.assetId}.png`))}><Download size={17} />{c.downloadCandidate}</button>
            <button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportOriginal(previewItem.result!.assetId, blob => makePoster(blob, `candidate-${previewItem.index + 1}.png`))}>{c.makePoster}</button>
            <button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportOriginal(previewItem.result!.assetId, blob => makeRecolor(blob, `candidate-${previewItem.index + 1}.png`))}>{c.makeRecolor}</button></div> :
            offer?<div role="region" aria-label={locale==='zh'?'确认本次用量':'Confirm credits'}><p>{locale==='zh'?`本次 ${offer.units} 积分 · 当前可用 ${offer.availableCredits} 积分`:`${offer.units} credits · ${offer.availableCredits} available`}</p><p className="control-help">{offer.availableCredits<offer.units?(locale==='zh'?'可用积分不足，请前往账户补充积分。':'Insufficient credits. Add credits from your account.'):null}</p><p className="control-help">{locale==='zh'?'最终失败或取消排队后按账本释放预留积分。过期积分不会重新变为有效积分。':'A final failure or queued cancellation releases the reservation. Expired credits retain their expiry.'}</p><button type="button" className="primary-button" onClick={acceptOffer} disabled={!sceneSubmitAllowed(pricing?.admissionOpen)||offer.availableCredits<offer.units}>{locale==='zh'?`确认生成 · ${offer.units} 积分`:`Confirm · ${offer.units} credits`}</button><button type="button" className="sample-button" onClick={()=>setOffer(undefined)}>{locale==='zh'?'返回编辑':'Back to editing'}</button></div>:readonly && output ? <><button type="button" className="primary-button" disabled={exporting} aria-busy={exporting} onClick={() => void exportOriginal(record.result!.assetId, blob => downloadPng(blob, `miaocut-product-${record.result!.assetId}.png`))}><Download size={17} />{t.download}</button>
            <button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportOriginal(record.result!.assetId, blob => makePoster(blob, `result-${record.result!.assetId}.png`))}>{c.makePoster}</button>
            <button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportOriginal(record.result!.assetId, blob => makeRecolor(blob, `result-${record.result!.assetId}.png`))}>{c.makeRecolor}</button></> :
            <><button type="button" className="primary-button" disabled={!connected || !sceneSubmitAllowed(pricing?.admissionOpen) || !!pending || quoting || uploadProgress !== null || !record.document.foregroundAssetId} onClick={() => void generate("product")}>{pending||quoting ? <LoaderCircle size={17} className="spinner" /> : null}{pending ? c.waiting : pricing?`${c.generate} · ${pricing.product}${locale==='zh'?' 积分':' credits'}`:c.generate}</button>
            {candidatesEnabled && pricing ? <button type="button" className="secondary-button" disabled={!connected || !sceneSubmitAllowed(pricing.admissionOpen) || quoting || uploadProgress !== null || !record.document.foregroundAssetId || candidatesBusy} onClick={() => void generateCandidates()}>
              {candidatesBusy ? <><LoaderCircle size={15} className="spinner" />{c.candidateBusy}</> : `${c.candidates} · ${CANDIDATE_COUNT * pricing.product}${locale === 'zh' ? ' 积分' : ' credits'}`}</button> : null}</>}<p className="control-help">{pricing?(locale==='zh'?'以确认的报价为准':'The confirmed quote applies'):c.mode}</p></div></aside>
      </div>
      {groupView && groupRecord && groupMatches(groupView, groupRecord) ? <CandidateStrip group={groupView} images={candidateImages} preview={preview} selectedAssetId={record.result?.assetId}
        locale={locale} busy={groupBusy} onPreview={index => setPreview(current => current === index ? null : index)} onStop={() => void groupAction("stop")} onResume={() => void groupAction("resume")} /> : null}
      <div className="job-status" role="status" aria-live="polite"><span className="job-status-leading">{spinning ? <LoaderCircle size={15} className="spinner" /> : warn ? <TriangleAlert size={15} /> : <Check size={15} />}{status}</span>
        {billingMessage?<span>{billingMessage}</span>:null}
        {pending?.jobId && currentJob?.state === "queued" ? <button type="button" onClick={() => void cancel()}>{c.cancel}</button> : null}</div>
      <section className="panel-section batch-history scene-history" aria-label={c.historyTitle}>
        <h2>{c.historyTitle}</h2>
        <p className="control-help">{c.historyHint}</p>
        {historyRows.length === 0 ? <p className="control-help">{c.historyEmpty}</p> : <ul className="batch-history-list">
          {historyRows.map(row => {
            const thumb = row.resultAssetId ? historyImages[row.resultAssetId] : undefined;
            const when = new Date(row.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
            return <li key={row.jobId} className="batch-history-item">
              <div className="batch-history-row">
                {thumb ? <span className="scene-history-thumb checkerboard"><BlobImage blob={thumb.blob} alt="" width={48} height={48} /></span> : <span className="scene-history-thumb" />}
                <span className="batch-history-when">{when}</span>
                <span className="batch-history-count">{t[row.scene]}</span>
                <span className={`batch-status ${row.state === "succeeded" ? "is-ok" : row.state === "failed" ? "is-bad" : row.state === "cancelled" ? "is-muted" : "is-busy"}`}>{row.state === "succeeded" ? c.done : row.state === "failed" ? (row.error === "job_expired" ? c.queueExpired : c.failed) : row.state === "cancelled" ? c.cancelled : row.state === "queued" ? c.queued : c.product}</span>
                <span className="batch-history-detail">{creditText(row)}</span>
                {row.resultAssetId ? <button type="button" className="secondary-button batch-history-action" onClick={() => openHistory(row)}>{c.historyView}</button> : null}
                {row.resultAssetId ? <button type="button" className="secondary-button batch-history-action" disabled={exporting} onClick={() => void exportOriginal(row.resultAssetId!, blob => downloadPng(blob, `miaocut-${row.scene}-${row.jobId}.png`))}><Download size={14} />{c.historyDownload}</button> : null}
              </div>
            </li>;
          })}
        </ul>}
      </section>
      <footer className="workspace-footer"><a href="/workbench/product">{c.returnDemo}</a><span>{record.result ? c.viewResult : c.noResult}</span></footer>
      {comparisonId&&connected?<>
        {record.result&&compositionKey(record.document)!==compositionKey(record.result.document)?<p className="control-help">{locale==='zh'?'下方对比使用上次完成结果的构图，当前编辑稿保持不变。':'The comparison uses the completed result’s layout; your current draft is unchanged.'}</p>:null}
        <SceneComparison document={comparisonDocument} foreground={asset?.id===comparisonId?asset:savedForeground?.id===comparisonId?savedForeground:undefined} ai={output?.blob} aiIsPreview={output?.preview===true} locale={locale}
          loadOriginal={{foreground:()=>fetchOriginal(comparisonId),ai:async()=>{if(!resultId)throw new ServiceError('asset_not_found',404);return (await fetchOriginal(resultId)).blob;}}}/>
      </>:null}
    </main></div>;
}
