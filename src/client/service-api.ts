import type { LocalAsset } from "@/domain/contracts";
import type { ServiceAsset, ServiceBatch, ServiceBatchQuote, ServiceBatchRequest, ServiceGroup, ServiceGroupQuote, ServiceGroupRequest, ServiceGroupSummary, ServiceJob, ServiceJobRequest } from "@/domain/service-contracts";
import { AssetError, decodeAsset, imageFromUrl } from "./assets";
import {accountToken} from './account-auth';
import { serviceUrl } from "@/domain/service-url";
import { AssetLoadError, createSharedLoader } from "@/domain/asset-loader";
import { cacheBlobStore, type CacheBlobStore } from "@/domain/asset-cache";

// 下载过的图按“资产编号 + 内容指纹”存在浏览器的 Cache Storage 里（见 domain/asset-cache.ts）：刷新、再次打开都不用重新下载。
// Cache Storage 只在安全上下文（https、localhost）里有；没有就不缓存，下载本身照常工作。
let assetStore: CacheBlobStore | undefined | null = null;
export function browserAssetStore(): CacheBlobStore | undefined {
  if (assetStore !== null) return assetStore;
  assetStore = typeof caches === "undefined" || typeof location === "undefined" ? undefined
    : cacheBlobStore(() => caches.open("mc-workbench-assets-v1") as unknown as Promise<import("@/domain/asset-cache").CacheLike>, { origin: location.origin });
  return assetStore;
}
const sha256Hex = async (data: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), n => n.toString(16).padStart(2, "0")).join("");
// 同一张图同时被多处要（页面一挂载就同时要显示用的抠图、结果图、对比用的抠图）只下一次：见 domain/asset-loader.ts 的 createSharedLoader。
const sharedImageLoader = createSharedLoader(() => ({
  fetchAsset: (url, attempt) => fetch(url, { signal: attempt, redirect: "error", credentials: "omit", cache: "no-store" }),
  sha256Hex, store: browserAssetStore(),
  sleep: (ms, abort) => new Promise<void>((resolve, reject) => {
    if (abort.aborted) { reject(abort.reason); return; }
    const timer = setTimeout(() => { abort.removeEventListener("abort", stop); resolve(); }, ms), stop = () => { clearTimeout(timer); reject(abort.reason); };
    abort.addEventListener("abort", stop, { once: true });
  }),
}));

export class ServiceError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}
export class WorkbenchService {
  constructor(private sessionKey: string) {}
  async call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token=await accountToken(this.sessionKey);
    if (!token) throw new ServiceError("login_required", 401);
    const response = await fetch(serviceUrl(path, process.env.NEXT_PUBLIC_WORKBENCH_API_URL), { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal, cache: "no-store", redirect: "error" });
    const data = await response.json();
    if (!response.ok) throw new ServiceError(data.error || "request_failed", response.status);
    return data;
  }
  asset(id: string, signal?: AbortSignal) { return this.call<ServiceAsset>(`assets/${id}`, undefined, signal); }
  job(id: string, signal?: AbortSignal) { return this.call<ServiceJob>(`jobs/${id}`, undefined, signal); }
  create(request: ServiceJobRequest, signal?: AbortSignal, quoteId?:string) { return this.call<ServiceJob>("jobs", quoteId?{request,quoteId}:request, signal); }
  quote(request:ServiceJobRequest) {return this.call<import('@/domain/service-contracts').ServiceQuote>('quotes',{request});}
  cancel(id: string) { return this.call<ServiceJob>(`jobs/${id}/cancel`, {}); }
  // 四候选：报价 → 确认（按 groupId + 请求内容幂等，可安全重发）→ 轮询组 → 停止剩余 / 补充积分后继续。
  groupQuote(request: ServiceGroupRequest) { return this.call<ServiceGroupQuote>("group-quotes", { request }); }
  createGroup(groupId: string, request: ServiceGroupRequest, signal?: AbortSignal) { return this.call<ServiceGroup>("groups", { groupId, request }, signal); }
  group(id: string, signal?: AbortSignal) { return this.call<ServiceGroup>(`groups/${id}`, undefined, signal); }
  cancelGroup(id: string) { return this.call<ServiceGroup>(`groups/${id}/cancel`, {}); }
  resumeGroup(id: string) { return this.call<ServiceGroup>(`groups/${id}/resume`, {}); }
  // 批量场景：与四候选共用同一组接口，请求里 kind 为 "batch"。报价响应不回显请求，确认时原样再发一次。
  batchQuote(request: ServiceBatchRequest) { return this.call<ServiceBatchQuote>("group-quotes", { request }); }
  createBatch(groupId: string, request: ServiceBatchRequest, signal?: AbortSignal) { return this.call<ServiceBatch>("groups", { groupId, request }, signal); }
  batch(id: string, signal?: AbortSignal) { return this.call<ServiceBatch>(`groups/${id}`, undefined, signal); }
  /** 我的批次（最近的在前，最多 50 个）：只有摘要。返回前由调用方过一遍 validGroupSummaries。 */
  batches(limit: number, signal?: AbortSignal) { return this.call<{ groups: ServiceGroupSummary[] }>(`groups?kind=batch&limit=${limit}`, undefined, signal); }
  cancelBatch(id: string) { return this.call<ServiceBatch>(`groups/${id}/cancel`, {}); }
  resumeBatch(id: string) { return this.call<ServiceBatch>(`groups/${id}/resume`, {}); }
  async upload(file: File, onProgress: (percent: number) => void): Promise<ServiceAsset> {
    const blob = await canonicalPng(file);
    const image = await decodeAsset(blob, file.name, "upload"), bytes = await blob.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
    const request = { requestId: crypto.randomUUID(), name: file.name, mime: "image/png", bytes: blob.size,
      sha256: digest, width: image.width, height: image.height };
    const upload = await this.call<{ assetId: string; putUrl?: string; putHeaders?: Record<string,string>; asset?: ServiceAsset }>("assets", request);
    if (upload.asset) return upload.asset;
    if (!upload.putUrl) throw new ServiceError("upload_unavailable");
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open("PUT", upload.putUrl!);
      for (const [key, value] of Object.entries(upload.putHeaders || {})) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
      xhr.timeout = 120_000;
      xhr.onerror = xhr.ontimeout = () => reject(new ServiceError("upload_failed"));
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ServiceError("upload_failed", xhr.status));
      xhr.send(blob);
    });
    return this.call<ServiceAsset>(`assets/${upload.assetId}/confirm`, {});
  }
  /**
   * 下载一张服务端图片。命中本地缓存就不发请求；否则带“多久没收到字节”的卡死检测、最多 2 次重试和进度回调（见 domain/asset-loader.ts）。
   * 字节对不上服务端公布的大小或 SHA-256 一律不要。失败时抛 ServiceError，code 是 asset_download_failed、asset_timeout 或 asset_mismatch。
   */
  async image(asset: ServiceAsset, signal?: AbortSignal, onProgress?: (loaded: number, total: number) => void): Promise<LocalAsset> {
    let blob: Blob;
    try { ({ blob } = await sharedImageLoader(asset, { signal, onProgress })); }
    catch (error) {
      if (error instanceof AssetLoadError) throw new ServiceError(error.code, error.status);
      throw error;
    }
    // Service results can exceed the 10 MB source-upload limit; canvas uses trusted server geometry.
    return { id: asset.assetId, name: "product.png", blob, width: asset.width, height: asset.height,
      bounds: asset.bounds, transparent: asset.transparent, origin: "upload" };
  }
}
export async function canonicalPng(file: File): Promise<Blob> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new AssetError("file_type");
  if (file.size > 10 * 1024 * 1024) throw new AssetError("file_size");
  const url = URL.createObjectURL(file);
  try {
    const image = await imageFromUrl(url);
    if (image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new AssetError("image_size");
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new AssetError("image_decode");
    ctx.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new AssetError("image_decode")), "image/png"));
    if (blob.size > 10 * 1024 * 1024) throw new AssetError("file_size");
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
