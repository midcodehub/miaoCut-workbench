"use client";

import { useRef, useState } from "react";
import { Archive, ArrowLeft, Ban, Check, ChevronDown, ChevronUp, Download, ImagePlus, LoaderCircle, Moon, Play, RefreshCw, Replace, RotateCcw, Scissors, Sun, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import { accountConfigured } from "@/client/account-auth";
import { useBatch } from "@/client/use-batch";
import {
  MAX_BATCH_PRODUCTS, SCENES, batchBudget, batchCounts, batchStoppable, entryPlacement, summaryIsLocal,
  type BatchEntryRecord, type CompositionRule, type SubjectReason,
} from "@/domain/batch";
import type { LocalAsset, SceneId } from "@/domain/contracts";
import type { ServiceGroupItemState, ServiceGroupSummary } from "@/domain/service-contracts";
import { BlobImage } from "./blob-image";

const copy = {
  zh: {
    title: "批量场景", intro: "一次放进最多 20 件商品，先逐张提取主体并检查，再套用同一个方案批量生成场景图。确认预算前不会扣积分；关闭页面后批次仍在服务端继续，回来可以接着看。",
    back: "返回场景工作台", language: "Switch to English", switchDark: "切换深色模式", switchLight: "切换浅色模式",
    unavailable: "批量场景依赖积分账本里的生成组，当前环境没有开放（不计费的内部模式不支持）。", paused: "暂时不接新的生成任务，已提交的批次会继续结算。",
    offline: "GPU 节点当前离线：上传和提交新任务暂停，已有任务的状态仍会更新。", unknown: "暂时无法确认 GPU 节点是否在线，上传和提交新任务暂停。",
    login: "请先使用已有 MiaoCut 账户登录。", access: "当前账户没有内部测试资格。", error: "连接或操作没有完成，已有记录会保留。", storage: "浏览器无法保存批次记录，请清理空间后重试。",
    insufficient: "可用积分不足，请先补充积分。", quoteExpired: "报价已过期（5 分钟有效），请重新确认预算。", tooManyBatches: "已经重新生成过多次，请开始新的一批。", empty: "还没有可提交的商品：需要至少一件主体已提取好、且没有被排除的商品。",
    account: "前往账户登录", dismiss: "关闭提示",
    productsTitle: "商品", dropHint: "拖入或选择图片（PNG、JPG、WebP，每张 10 MB 以内、每边 ≤4096 px）", add: "添加图片", count: (n: number) => `${n} / ${MAX_BATCH_PRODUCTS}`, full: "已达 20 件上限",
    empty_list: "还没有商品。添加图片后会自动上传并提取主体（内测期间免费）。",
    colFile: "商品", colSubject: "主体", colResult: "1:1 画幅", colActions: "操作",
    uploading: (p: number) => `上传中 ${p}%`, uploaded: "等待提取主体", extracting: "正在提取主体", ready: "主体已提取", failedExtract: "没有完成",
    suspicious: "可疑", okSubject: "正常", excluded: "已排除", included: "参与", interrupted: "上传被中断，请重新选择这张图片。",
    tiny: "主体面积很小，可能没有识别到商品", huge: "主体几乎占满画面，可能把背景当成了主体", edges: "主体贴着两条以上的图像边，商品可能被裁掉了一部分", fragmented: "有多个较大的主体块，可能有多个商品或背景残留",
    file_type: "不支持这种格式", file_size: "图片超过 10 MB", image_size: "图片边长超过 4096 px", image_decode: "图片无法读取", expired: "素材已过期，请重新上传", queueExpired: "排队过久，任务已过期", failed: "提取失败", cancelled: "已取消",
    segment_not_free: "提取需要积分，这里不会自动确认", asset_not_found: "素材不存在", upload_failed: "上传失败",
    exclude: "排除", restore: "恢复", replace: "替换原图", remove: "移除", retry: "重新提取", download: "下载这张", locked: "已提交，不能再改动",
    planTitle: "方案", scene: "场景", ratio: "画幅", ratioSoon: "待开放", scale: "主体大小", anchor: "位置", space: "文字留白",
    marble: "大理石", wood: "原木", geometry: "极简几何", s: "小", m: "中", l: "大", bottom: "底部落地", center: "居中", none: "无", left: "左侧", right: "右侧", top: "上方",
    planHint: "整批共享同一方案。每件商品的位置由商品形状和这套规则自动算出，下面的预览就是实际提交的构图。",
    budgetTitle: "预算", submitCount: (n: number) => `提交 ${n} 件`, budget: (n: number, unit: number) => `${n} 件 × ${unit} 积分 = ${n * unit} 积分`, waitExtract: "还有商品在上传或提取主体，完成后才能确认预算。",
    suspiciousNote: (n: number) => `${n} 件主体可疑，不会被自动排除。请先检查，必要时排除或替换原图。`, confirmBudget: "确认预算", quoting: "正在报价",
    offerTitle: "确认本批用量", offerLine: (items: number, units: number, available: number) => `${items} 件 · 最多 ${units} 积分 · 当前可用 ${available} 积分`,
    offerNote: "只在每件商品生成成功后扣减；最终失败的释放预留。同一批最多同时预留 2 件，其余等待。", insufficientCredits: "可用积分不足，请先补充积分。",
    confirmRun: (units: number) => `确认生成 · 最多 ${units} 积分`, backEdit: "返回修改", redoOffer: "重新生成失败项",
    progress: "进度", doneCount: "完成", runningCount: "生成中", queuedCount: "排队", waitingCount: "等待", failedCount: "失败", excludedCount: "排除", used: (spent: number, budget: number) => `已用 ${spent} / 预算 ${budget}`,
    pausedCredits: "积分不足，批次已暂停：补充积分后点“继续”，剩余的项会接着生成。", stop: "停止剩余", resume: "继续", redo: (n: number, units: number) => `重新生成失败项 · ${n} 件 · ${units} 积分`,
    zip: "下载已完成 ZIP", zipDone: (n: number) => `已打包 ${n} 张`, startOver: "开始新的一批", startOverHint: "清空商品和结果，重新开始。已下载的文件不受影响。",
    eta: "单张约 1～2 分钟（按已有实测估算），GPU 节点离线时暂停。",
    waiting: "等待中", awaiting_credits: "等待积分", queued: "已排队", leased: "正在生成", verifying: "正在校验", settling: "正在保存", succeeded: "已完成", state_failed: "失败", state_cancelled: "已停止",
    preview: "构图预览", notFound: "找不到这个批次，可能已经过期。",
    historyTitle: "我的批次", historyHint: "换了设备或清了浏览器记录，也能在这里找回最近 10 个批次：查看结果、停止或下载。", historyEmpty: "还没有提交过批次。",
    historyError: "没能读取批次列表，会自动重试。", refresh: "刷新列表", historyCount: (n: number) => `${n} 件`, thisPage: "当前页面", viewResults: "查看结果", hideResults: "收起",
    groupRunning: "进行中", groupPaused: "等待积分", groupCompleted: "已完成", groupCancelled: "已停止", itemN: (n: number) => `第 ${n} 件`, loadingBatch: "正在读取批次…",
    remoteHint: "这个批次不是在当前浏览器里提交的，没有原文件名：下载的文件按“商品序号 + 场景”命名。", zipRemote: "下载已完成 ZIP",
  },
  en: {
    title: "Batch scenes", intro: "Add up to 20 products, extract and check each subject, then apply one plan to generate scene images in bulk. Nothing is charged before you confirm the budget; the batch keeps running on the server if you close the page.",
    back: "Back to scene workspace", language: "切换为中文", switchDark: "Switch to dark mode", switchLight: "Switch to light mode",
    unavailable: "Batch scenes need generation groups in the credit ledger, which this environment does not offer (unbilled internal mode does not support them).", paused: "New generation jobs are paused. Batches you already submitted keep settling.",
    offline: "The GPU node is offline: uploads and new jobs are paused. Existing jobs keep updating.", unknown: "The GPU node status is unknown, so uploads and new jobs are paused.",
    login: "Sign in with your existing MiaoCut account first.", access: "This account is not in the internal test.", error: "The operation did not finish. Existing records are kept.", storage: "The browser cannot save the batch. Free some space and retry.",
    insufficient: "Not enough credits. Add credits first.", quoteExpired: "The quote expired (valid for 5 minutes). Confirm the budget again.", tooManyBatches: "You have regenerated many times. Start a new batch.", empty: "Nothing to submit yet: you need at least one product with a finished subject that is not excluded.",
    account: "Go to account login", dismiss: "Dismiss",
    productsTitle: "Products", dropHint: "Drop or choose images (PNG, JPG, WebP, up to 10 MB each, up to 4096 px a side)", add: "Add images", count: (n: number) => `${n} / ${MAX_BATCH_PRODUCTS}`, full: "20 products is the limit",
    empty_list: "No products yet. Added images are uploaded and their subjects extracted automatically (free during the test).",
    colFile: "Product", colSubject: "Subject", colResult: "1:1", colActions: "Actions",
    uploading: (p: number) => `Uploading ${p}%`, uploaded: "Waiting to extract", extracting: "Extracting subject", ready: "Subject ready", failedExtract: "Did not finish",
    suspicious: "Suspicious", okSubject: "Looks fine", excluded: "Excluded", included: "Included", interrupted: "The upload was interrupted. Choose this image again.",
    tiny: "The subject is very small; the product may not have been found", huge: "The subject fills almost the whole image; the background may have been taken as the subject", edges: "The subject touches two or more image edges; part of the product may be cut off", fragmented: "Several large pieces were found; there may be more than one product or leftover background",
    file_type: "Unsupported format", file_size: "Over 10 MB", image_size: "Over 4096 px a side", image_decode: "The image cannot be read", expired: "The asset expired. Upload again", queueExpired: "Queued too long; the job expired", failed: "Extraction failed", cancelled: "Cancelled",
    segment_not_free: "Extraction costs credits; it is not confirmed automatically here", asset_not_found: "The asset was not found", upload_failed: "Upload failed",
    exclude: "Exclude", restore: "Restore", replace: "Replace image", remove: "Remove", retry: "Extract again", download: "Download this one", locked: "Already submitted; cannot be changed",
    planTitle: "Plan", scene: "Scene", ratio: "Ratio", ratioSoon: "Coming soon", scale: "Subject size", anchor: "Position", space: "Space for text",
    marble: "Marble", wood: "Wood", geometry: "Geometry", s: "Small", m: "Medium", l: "Large", bottom: "On the surface", center: "Centred", none: "None", left: "Left", right: "Right", top: "Top",
    planHint: "One plan for the whole batch. Each product's position is computed from its shape and these rules; the previews below show the exact composition that will be submitted.",
    budgetTitle: "Budget", submitCount: (n: number) => `${n} to submit`, budget: (n: number, unit: number) => `${n} × ${unit} credits = ${n * unit} credits`, waitExtract: "Some products are still uploading or extracting. You can confirm the budget when they finish.",
    suspiciousNote: (n: number) => `${n} suspicious subject(s) are not excluded automatically. Check them and exclude or replace if needed.`, confirmBudget: "Confirm budget", quoting: "Getting a quote",
    offerTitle: "Confirm this batch", offerLine: (items: number, units: number, available: number) => `${items} items · up to ${units} credits · ${available} credits available`,
    offerNote: "Charged only after each product succeeds; a final failure releases its reservation. At most 2 items of a batch are reserved at a time; the rest wait.", insufficientCredits: "Not enough credits. Add credits first.",
    confirmRun: (units: number) => `Confirm · up to ${units} credits`, backEdit: "Back to editing", redoOffer: "Regenerate failed items",
    progress: "Progress", doneCount: "Done", runningCount: "Running", queuedCount: "Queued", waitingCount: "Waiting", failedCount: "Failed", excludedCount: "Excluded", used: (spent: number, budget: number) => `Used ${spent} / budget ${budget}`,
    pausedCredits: "Credits ran out and the batch paused. Add credits and choose Resume; the remaining items continue.", stop: "Stop the rest", resume: "Resume", redo: (n: number, units: number) => `Regenerate failed · ${n} item(s) · ${units} credits`,
    zip: "Download finished as ZIP", zipDone: (n: number) => `${n} image(s) packed`, startOver: "Start a new batch", startOverHint: "Clears the products and results. Files you already downloaded are not affected.",
    eta: "About 1–2 minutes per image (from earlier measurements); paused while the GPU node is offline.",
    waiting: "Waiting", awaiting_credits: "Waiting for credits", queued: "Queued", leased: "Generating", verifying: "Checking", settling: "Saving", succeeded: "Done", state_failed: "Failed", state_cancelled: "Stopped",
    preview: "Composition preview", notFound: "This batch was not found; it may have expired.",
    historyTitle: "My batches", historyHint: "If you switched devices or cleared this browser, your 10 latest batches are still here: view results, stop, or download.", historyEmpty: "No batches submitted yet.",
    historyError: "Could not load your batches. Retrying automatically.", refresh: "Refresh list", historyCount: (n: number) => `${n} item(s)`, thisPage: "This page", viewResults: "View results", hideResults: "Hide",
    groupRunning: "Running", groupPaused: "Waiting for credits", groupCompleted: "Completed", groupCancelled: "Stopped", itemN: (n: number) => `Item ${n}`, loadingBatch: "Loading the batch…",
    remoteHint: "This batch was not submitted in this browser, so original file names are not available: downloads are named by product number and scene.", zipRemote: "Download finished as ZIP",
  },
};
type Copy = (typeof copy)["zh"] | (typeof copy)["en"];
const sceneClass: Record<SceneId, string> = { marble: "scene-marble", wood: "scene-wood", geometry: "scene-geometry" };
const rule = <K extends keyof CompositionRule>(key: K, value: CompositionRule[K], current: CompositionRule): CompositionRule => ({ ...current, [key]: value });
const stateLabel = (state: ServiceGroupItemState, c: Copy) => (state === "failed" ? c.state_failed : state === "cancelled" ? c.state_cancelled : c[state]);
const stateClass = (state: ServiceGroupItemState) => (state === "succeeded" ? "is-ok" : state === "failed" ? "is-bad" : state === "cancelled" ? "is-muted" : "is-busy");
const groupLabel = (status: ServiceGroupSummary["status"], c: Copy) => (status === "running" ? c.groupRunning : status === "paused" ? c.groupPaused : status === "completed" ? c.groupCompleted : c.groupCancelled);
const groupClass = (status: ServiceGroupSummary["status"]) => (status === "running" ? "is-busy" : status === "paused" ? "is-warn" : status === "completed" ? "is-ok" : "is-muted");
/** 列表一行的进度文字。用户停止的批次里没来得及开始的项显示为“已停止”，其余只列出非零的计数。 */
function progressText(row: ServiceGroupSummary, c: Copy) {
  const { counts } = row, stopped = row.status === "cancelled" ? counts.cancelled + counts.waiting : counts.cancelled, waiting = row.status === "cancelled" ? 0 : counts.waiting;
  return [`${c.doneCount} ${counts.succeeded}`, counts.running ? `${c.runningCount} ${counts.running}` : "", waiting ? `${c.waitingCount} ${waiting}` : "",
    counts.failed ? `${c.failedCount} ${counts.failed}` : "", stopped ? `${c.state_cancelled} ${stopped}` : ""].filter(Boolean).join(" · ");
}

/** 构图预览：场景背景上按放置矩形裁出主体的可见部分（前景图是整张原图大小，所以要按可见包围盒裁剪）。 */
function PlacementTile({ entry, thumb, scene, plan }: { entry: BatchEntryRecord; thumb: LocalAsset | undefined; scene: SceneId; plan: Parameters<typeof entryPlacement>[1] }) {
  const placement = entryPlacement(entry, plan), bounds = entry.bounds;
  return <span className={`batch-tile ${sceneClass[scene]}`} role="img" aria-label="preview">
    {thumb && bounds ? <span className="batch-tile-subject" style={{ left: `${placement.x * 100}%`, top: `${placement.y * 100}%`, width: `${placement.width * 100}%`, height: `${placement.height * 100}%` }}>
      <BlobImage blob={thumb.blob} alt="" style={{ left: `${(-bounds.x / bounds.width) * 100}%`, top: `${(-bounds.y / bounds.height) * 100}%`, width: `${(thumb.width / bounds.width) * 100}%`, height: `${(thumb.height / bounds.height) * 100}%` }} />
    </span> : null}</span>;
}

export function BatchWorkbench({ sessionKey }: { sessionKey: string }) {
  const app = useBatch(sessionKey), c = copy[app.locale];
  const input = useRef<HTMLInputElement>(null), replaceInput = useRef<HTMLInputElement>(null), replaceTarget = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false), [zipNote, setZipNote] = useState<string | null>(null), [zipBusy, setZipBusy] = useState(false), [remoteZipBusy, setRemoteZipBusy] = useState(false);
  const formatTime = (ms: number) => new Date(ms).toLocaleString(app.locale === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const online = app.execution === "online", admissionOpen = app.pricing?.admissionOpen !== false;
  const unit = app.pricing?.product ?? 0, sourceReady = app.entries.every(entry => ["ready", "failed"].includes(entry.stage));
  const suspicious = app.ready.filter(entry => (entry.check?.reasons.length ?? 0) > 0).length;
  const canAdd = app.connected && !!app.limits && online && admissionOpen && app.entries.length < MAX_BATCH_PRODUCTS;
  const newestCounts = app.newestView ? batchCounts(app.newestView) : null;
  const doneCount = app.doneCount, excludedCount = app.entries.filter(entry => entry.excluded).length;
  const spent = Object.values(app.views).reduce((sum, view) => sum + view.settledUnits, 0), budget = app.groups.reduce((sum, group) => sum + (app.views[group.groupId]?.budgetUnits ?? 0), 0);
  const stats = (() => {
    const counts = { running: 0, queued: 0, waiting: 0, failed: 0 };
    for (const entry of app.entries) {
      const state = app.outcomes[entry.entryId]?.item.state;
      if (!state) continue;
      if (["leased", "verifying", "settling"].includes(state)) counts.running++; else if (state === "queued") counts.queued++; else if (["waiting", "awaiting_credits"].includes(state)) counts.waiting++; else if (state === "failed") counts.failed++;
    }
    return counts;
  })();
  const running = !!app.activeGroup;
  const reasonText = (reasons: SubjectReason[]) => reasons.map(reason => c[reason]).join("；");
  const problemText = app.problem ? c[app.problem] : null;

  const pickFiles = (list: FileList | null) => { if (list && list.length > 0) app.addFiles(Array.from(list)); };
  const subjectCell = (entry: BatchEntryRecord) => {
    const percent = app.progress[entry.entryId];
    if (entry.stage === "uploading") return <span className="batch-status is-busy"><LoaderCircle size={13} className="spinner" />{c.uploading(percent ?? 0)}</span>;
    if (entry.stage === "uploaded") return <span className="batch-status is-busy"><LoaderCircle size={13} className="spinner" />{c.uploaded}</span>;
    if (entry.stage === "extracting") return <span className="batch-status is-busy"><LoaderCircle size={13} className="spinner" />{c.extracting}</span>;
    if (entry.stage === "failed") {
      const text = !entry.sourceAssetId && !entry.error ? c.interrupted : (entry.error && entry.error in c ? (c as unknown as Record<string, string>)[entry.error] : c.failedExtract);
      return <span className="batch-status is-bad" title={entry.error}><TriangleAlert size={13} />{text}</span>;
    }
    if (entry.excluded) return <span className="batch-status is-muted"><Ban size={13} />{c.excluded}</span>;
    return entry.check?.reasons.length ? <span className="batch-status is-warn" title={reasonText(entry.check.reasons)}><TriangleAlert size={13} />{c.suspicious}</span> : <span className="batch-status is-ok"><Check size={13} />{c.okSubject}</span>;
  };
  const resultCell = (entry: BatchEntryRecord) => {
    const outcome = app.outcomes[entry.entryId], image = app.resultOf(entry.entryId), thumb = app.thumbs[entry.entryId];
    if (outcome) {
      const state = outcome.item.state;
      return <span className="batch-result">
        {image ? <span className="batch-result-image checkerboard"><BlobImage blob={image.blob} alt="" /></span> : <span className="batch-result-image batch-result-empty">{state === "succeeded" ? <LoaderCircle size={14} className="spinner" /> : null}</span>}
        <span className={`batch-status ${state === "succeeded" ? "is-ok" : state === "failed" ? "is-bad" : state === "cancelled" ? "is-muted" : "is-busy"}`}>
          {["queued", "leased", "verifying", "settling"].includes(state) ? <LoaderCircle size={13} className="spinner" /> : null}{stateLabel(state, c)}</span></span>;
    }
    if (entry.stage === "ready" && !entry.excluded) return <span className="batch-result"><PlacementTile entry={entry} thumb={thumb} scene={app.plan.scene} plan={app.plan} /><span className="batch-status is-muted">{c.preview}</span></span>;
    return <span className="batch-status is-muted">—</span>;
  };

  return <div className="workbench-app batch-app">
    <header className="site-header"><div className="header-content">
      <a href="https://miaocut.app" className="brand-link" aria-label="MiaoCut"><span className="brand-mark"><Scissors size={19} strokeWidth={1.7} /></span>MiaoCut</a>
      <span className="header-divider" /><span className="header-workspace">{c.title}</span>
      <div className="header-actions"><a className="header-link" href="/workbench/product/internal"><ArrowLeft size={13} />{c.back}</a>
        <button type="button" className="icon-button language-button" aria-label={c.language} onClick={() => app.setLocale(app.locale === "zh" ? "en" : "zh")}>{app.locale === "zh" ? "EN" : "中"}</button>
        <button type="button" className="icon-button" aria-label={app.dark ? c.switchLight : c.switchDark} onClick={app.toggleTheme}>{app.dark ? <Sun size={18} /> : <Moon size={18} />}</button></div>
    </div></header>
    <main className="workspace-main">
      <div className="page-heading"><div><h1>{c.title}</h1><p>{c.intro}</p></div></div>
      {problemText ? <div className="error-notice" role="alert"><span>{problemText}</span>
        {app.problem === "login" || app.problem === "access" ? <a href={accountConfigured() ? "/workbench/login" : "https://miaocut.app/account/"}>{c.account}</a>
          : <button type="button" className="icon-button" aria-label={c.dismiss} onClick={app.dismissProblem}><X size={16} /></button>}</div> : null}
      {app.connected && !app.limits ? <div className="demo-notice" role="status">{c.unavailable}</div> : null}
      {app.connected && !admissionOpen ? <div className="demo-notice" role="status">{c.paused}</div> : null}
      {app.connected && app.limits && !online ? <div className="demo-notice" role="status">{app.execution === "offline" ? c.offline : c.unknown}</div> : null}

      <div className="batch-grid">
        <section className="side-panel batch-main" aria-label={c.productsTitle}>
          <div className="panel-section">
            <div className="section-title"><h2>{c.productsTitle}</h2><span className="batch-count">{c.count(app.entries.length)}</span></div>
            <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" aria-label={c.add} onChange={event => { pickFiles(event.target.files); event.currentTarget.value = ""; }} />
            <input ref={replaceInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={c.replace}
              onChange={event => { const file = event.target.files?.[0], target = replaceTarget.current; if (file && target) app.replaceEntry(target, file); replaceTarget.current = null; event.currentTarget.value = ""; }} />
            <button type="button" className={`upload-zone batch-drop ${dragging ? "is-dragging" : ""}`} disabled={!canAdd || running} onClick={() => input.current?.click()}
              onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); setDragging(false); if (canAdd && !running) pickFiles(event.dataTransfer.files); }}>
              <ImagePlus size={22} /><span className="upload-zone-label">{app.entries.length >= MAX_BATCH_PRODUCTS ? c.full : c.add}</span><small>{c.dropHint}</small></button>
            {app.entries.length === 0 ? <p className="control-help">{c.empty_list}</p> : <div className="batch-table" role="table" aria-label={c.productsTitle}>
              <div className="batch-row batch-head" role="row"><span role="columnheader">{c.colFile}</span><span role="columnheader">{c.colSubject}</span><span role="columnheader">{c.colResult}</span><span role="columnheader">{c.colActions}</span></div>
              {app.entries.map(entry => {
                const locked = app.locked.has(entry.entryId), thumb = app.thumbs[entry.entryId], outcome = app.outcomes[entry.entryId];
                return <div key={entry.entryId} className={`batch-row ${entry.excluded ? "is-excluded" : ""}`} role="row">
                  <span className="batch-file" role="cell"><span className="batch-thumb checkerboard">{thumb ? <BlobImage blob={thumb.blob} alt="" style={{ objectFit: "contain" }} /> : null}</span>
                    <span className="batch-name" title={entry.fileName}>{entry.fileName}</span></span>
                  <span className="batch-cell" role="cell">{subjectCell(entry)}
                    {entry.check?.reasons.length && !entry.excluded ? <small className="batch-reason">{reasonText(entry.check.reasons)}</small> : null}</span>
                  <span className="batch-cell" role="cell">{resultCell(entry)}</span>
                  <span className="batch-actions" role="cell">
                    {outcome?.item.state === "succeeded" ? <button type="button" className="icon-button" aria-label={`${c.download}: ${entry.fileName}`} title={c.download} disabled={!app.resultOf(entry.entryId)} onClick={() => app.downloadOne(entry.entryId)}><Download size={14} /></button> : null}
                    {entry.stage === "ready" ? <button type="button" className="icon-button" aria-label={`${entry.excluded ? c.restore : c.exclude}: ${entry.fileName}`} title={locked ? c.locked : entry.excluded ? c.restore : c.exclude} disabled={locked}
                      onClick={() => app.setExcluded(entry.entryId, !entry.excluded)}>{entry.excluded ? <Undo2 size={14} /> : <Ban size={14} />}</button> : null}
                    {entry.stage === "failed" && entry.sourceAssetId ? <button type="button" className="icon-button" aria-label={`${c.retry}: ${entry.fileName}`} title={c.retry} disabled={locked || !online} onClick={() => app.retryEntry(entry.entryId)}><RotateCcw size={14} /></button> : null}
                    {["ready", "failed"].includes(entry.stage) ? <button type="button" className="icon-button" aria-label={`${c.replace}: ${entry.fileName}`} title={locked ? c.locked : c.replace} disabled={locked || !online}
                      onClick={() => { replaceTarget.current = entry.entryId; replaceInput.current?.click(); }}><Replace size={14} /></button> : null}
                    <button type="button" className="icon-button" aria-label={`${c.remove}: ${entry.fileName}`} title={locked ? c.locked : c.remove} disabled={locked} onClick={() => app.removeEntry(entry.entryId)}><Trash2 size={14} /></button>
                  </span>
                </div>;
              })}</div>}
          </div>

          {app.groups.length > 0 ? <div className="panel-section batch-progress" role="status" aria-live="polite">
            <div className="section-title"><h2>{c.progress}</h2></div>
            <p className="batch-summary"><strong>{c.doneCount} {doneCount}</strong> · {c.runningCount} {stats.running} · {c.queuedCount} {stats.queued} · {c.waitingCount} {stats.waiting} · {c.failedCount} {stats.failed} · {c.excludedCount} {excludedCount}
              {budget > 0 ? <span className="batch-budget-line"> · {c.used(spent, budget)}</span> : null}</p>
            {newestCounts && app.newestView?.status === "paused" ? <p className="poster-warning" role="alert"><TriangleAlert size={13} />{c.pausedCredits}</p> : null}
            {running ? <p className="control-help">{c.eta}</p> : null}
            <div className="batch-buttons">
              {app.activeGroup && app.views[app.activeGroup.groupId] && batchStoppable(app.views[app.activeGroup.groupId]) ? <button type="button" className="secondary-button" disabled={app.busy} onClick={() => void app.stop(app.activeGroup!.groupId)}><Ban size={15} />{c.stop}</button> : null}
              {app.activeGroup && app.views[app.activeGroup.groupId]?.status === "paused" ? <button type="button" className="secondary-button" disabled={app.busy || !online} onClick={() => void app.resumeGroup(app.activeGroup!.groupId)}><Play size={15} />{c.resume}</button> : null}
              {!running && app.failedCount > 0 ? <button type="button" className="secondary-button" disabled={app.quoting || !online || !admissionOpen} onClick={() => void app.requestRedo()}>
                {app.quoting ? <LoaderCircle size={15} className="spinner" /> : <RefreshCw size={15} />}{c.redo(app.failedCount, batchBudget(app.failedCount, unit))}</button> : null}
              <button type="button" className="primary-button" disabled={zipBusy || doneCount === 0} onClick={() => { setZipBusy(true); setZipNote(null); void app.downloadZip().then(n => setZipNote(c.zipDone(n))).catch(() => app.dismissProblem()).finally(() => setZipBusy(false)); }}>
                {zipBusy ? <LoaderCircle size={15} className="spinner" /> : <Archive size={15} />}{c.zip}{doneCount > 0 ? ` · ${doneCount}` : ""}</button>
              {!running ? <button type="button" className="sample-button" onClick={app.startOver}>{c.startOver}</button> : null}
            </div>
            {zipNote ? <p className="control-help">{zipNote}</p> : null}
            {!running ? <p className="control-help">{c.startOverHint}</p> : null}
          </div> : null}

          {app.limits ? <div className="panel-section batch-history" aria-label={c.historyTitle}>
            <div className="section-title"><h2>{c.historyTitle}</h2>
              <button type="button" className="icon-button" aria-label={c.refresh} title={c.refresh} disabled={app.historyState === "loading"} onClick={() => void app.refreshHistory()}>
                <RefreshCw size={14} className={app.historyState === "loading" ? "spinner" : undefined} /></button></div>
            <p className="control-help">{c.historyHint}</p>
            {app.historyState === "error" ? <p className="poster-warning" role="alert"><TriangleAlert size={13} />{c.historyError}</p> : null}
            {app.history.length === 0 && app.historyState !== "error" ? <p className="control-help">{app.historyState === "loading" ? c.loadingBatch : c.historyEmpty}</p> : null}
            {app.history.length > 0 ? <ul className="batch-history-list">
              {app.history.map(row => {
                const local = summaryIsLocal(row, app.groups), isOpen = app.opened === row.groupId, view = isOpen ? app.openedView : undefined;
                const remoteDone = view ? view.items.filter(item => app.remoteResult(item)).length : 0;
                return <li key={row.groupId} className="batch-history-item">
                  <div className="batch-history-row">
                    <span className="batch-history-when">{formatTime(row.createdAt)}</span>
                    <span className="batch-history-count">{c.historyCount(row.count)}</span>
                    <span className={`batch-status ${groupClass(row.status)}`}>{groupLabel(row.status, c)}</span>
                    {local ? <span className="batch-status is-muted batch-history-action">{c.thisPage}</span>
                      : <button type="button" className="secondary-button batch-history-action" aria-expanded={isOpen} onClick={() => (isOpen ? app.closeGroup() : app.openGroup(row.groupId))}>
                        {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{isOpen ? c.hideResults : c.viewResults}</button>}
                    <span className="batch-history-detail">{progressText(row, c)} · {c.used(row.settledUnits, row.budgetUnits)}</span>
                  </div>
                  {isOpen ? <div className="batch-remote" role="region" aria-label={c.viewResults}>
                    <p className="control-help">{c.remoteHint}</p>
                    {!view ? <p className="control-help" role="status"><LoaderCircle size={13} className="spinner" /> {c.loadingBatch}</p> : <>
                      {view.status === "paused" ? <p className="poster-warning" role="alert"><TriangleAlert size={13} />{c.pausedCredits}</p> : null}
                      <ul className="batch-remote-grid">
                        {view.items.map(item => {
                          const image = app.remoteResult(item);
                          return <li key={item.index} className="batch-remote-item">
                            <span className="batch-result-image batch-remote-image checkerboard">{image ? <BlobImage blob={image.blob} alt="" /> : item.state === "succeeded" ? <LoaderCircle size={14} className="spinner" /> : null}</span>
                            <span className="batch-remote-name">{c.itemN(item.index + 1)}</span>
                            <span className={`batch-status ${stateClass(item.state)}`}>{["queued", "leased", "verifying", "settling"].includes(item.state) ? <LoaderCircle size={13} className="spinner" /> : null}{stateLabel(item.state, c)}</span>
                            {image ? <button type="button" className="icon-button" aria-label={`${c.download}: ${c.itemN(item.index + 1)}`} title={c.download} onClick={() => app.downloadRemoteOne(item)}><Download size={14} /></button> : null}
                          </li>;
                        })}
                      </ul>
                      <div className="batch-buttons">
                        {batchStoppable(view) ? <button type="button" className="secondary-button" disabled={app.busy} onClick={() => void app.stop(view.groupId)}><Ban size={15} />{c.stop}</button> : null}
                        {view.status === "paused" ? <button type="button" className="secondary-button" disabled={app.busy || !online} onClick={() => void app.resumeGroup(view.groupId)}><Play size={15} />{c.resume}</button> : null}
                        <button type="button" className="primary-button" disabled={remoteZipBusy || remoteDone === 0}
                          onClick={() => { setRemoteZipBusy(true); void app.downloadRemoteZip(view.groupId).catch(() => app.dismissProblem()).finally(() => setRemoteZipBusy(false)); }}>
                          {remoteZipBusy ? <LoaderCircle size={15} className="spinner" /> : <Archive size={15} />}{c.zipRemote}{remoteDone > 0 ? ` · ${remoteDone}` : ""}</button>
                      </div>
                    </>}
                  </div> : null}
                </li>;
              })}
            </ul> : null}
          </div> : null}
        </section>

        <aside className="side-panel batch-side" aria-label={c.planTitle}>
          <div className="panel-section">
            <div className="section-title"><h2>{c.planTitle}</h2></div>
            <div className="poster-field"><span>{c.scene}</span><div className="batch-scenes" role="group" aria-label={c.scene}>
              {SCENES.map(scene => <button type="button" key={scene} className={`scene-card ${app.plan.scene === scene ? "is-selected" : ""}`} aria-pressed={app.plan.scene === scene} disabled={running}
                onClick={() => app.setPlan({ ...app.plan, scene })}><span className={`scene-thumbnail ${sceneClass[scene]}`} /><strong>{c[scene]}</strong></button>)}</div></div>
            <div className="poster-field"><span>{c.ratio}</span><div className="poster-segment" role="group" aria-label={c.ratio}>
              <button type="button" aria-pressed="true">1:1</button>
              {["3:4", "9:16", "16:9"].map(ratio => <button type="button" key={ratio} disabled title={c.ratioSoon}>{ratio}</button>)}</div></div>
            <div className="poster-field"><span>{c.scale}</span><div className="poster-segment" role="group" aria-label={c.scale}>
              {(["s", "m", "l"] as const).map(value => <button type="button" key={value} aria-pressed={app.plan.composition.subjectScale === value} disabled={running}
                onClick={() => app.setPlan({ ...app.plan, composition: rule("subjectScale", value, app.plan.composition) })}>{c[value]}</button>)}</div></div>
            <div className="poster-field"><span>{c.anchor}</span><div className="poster-segment" role="group" aria-label={c.anchor}>
              {(["bottom", "center"] as const).map(value => <button type="button" key={value} aria-pressed={app.plan.composition.anchor === value} disabled={running}
                onClick={() => app.setPlan({ ...app.plan, composition: rule("anchor", value, app.plan.composition) })}>{c[value]}</button>)}</div></div>
            <div className="poster-field"><span>{c.space}</span><div className="poster-segment" role="group" aria-label={c.space}>
              {(["none", "left", "right", "top"] as const).map(value => <button type="button" key={value} aria-pressed={app.plan.composition.negativeSpace === value} disabled={running}
                onClick={() => app.setPlan({ ...app.plan, composition: rule("negativeSpace", value, app.plan.composition) })}>{c[value]}</button>)}</div></div>
            <p className="control-help">{c.planHint}</p>
          </div>
          <div className="panel-section batch-budget">
            <div className="section-title"><h2>{c.budgetTitle}</h2></div>
            {app.offer ? <div role="region" aria-label={c.offerTitle}>
              <p className="batch-offer-line"><strong>{c.offerTitle}</strong></p>
              <p>{c.offerLine(app.offer.quote.count, app.offer.quote.units, app.offer.quote.availableCredits)}</p>
              <p className="control-help">{c.offerNote}</p>
              {app.offer.quote.availableCredits < app.offer.quote.units ? <p className="poster-warning" role="alert"><TriangleAlert size={13} />{c.insufficientCredits}</p> : null}
              <button type="button" className="primary-button" disabled={!online || app.offer.quote.availableCredits < app.offer.quote.units} onClick={app.acceptOffer}>{c.confirmRun(app.offer.quote.units)}</button>
              <button type="button" className="sample-button" onClick={app.dismissOffer}>{c.backEdit}</button>
            </div> : <>
              <p className="batch-offer-line"><strong>{c.submitCount(app.readyCount)}</strong></p>
              <p>{app.readyCount > 0 ? c.budget(app.readyCount, unit) : "—"}</p>
              {!sourceReady ? <p className="control-help" role="status">{c.waitExtract}</p> : null}
              {suspicious > 0 ? <p className="poster-warning" role="status"><TriangleAlert size={13} />{c.suspiciousNote(suspicious)}</p> : null}
              <button type="button" className="primary-button" disabled={!app.connected || !app.limits || !online || !admissionOpen || app.readyCount === 0 || !sourceReady || app.quoting || running}
                onClick={() => void app.requestQuote()}>{app.quoting ? <LoaderCircle size={17} className="spinner" /> : null}{app.quoting ? c.quoting : c.confirmBudget}</button>
            </>}
          </div>
        </aside>
      </div>
    </main>
  </div>;
}
