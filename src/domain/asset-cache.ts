// 把浏览器的 Cache Storage 包成 asset-loader 要的 BlobStore。
//
// 为什么用 Cache Storage 而不是 HTTP 缓存：资产的下载链接是预签名的（每次都不一样，约 15 分钟过期），HTTP 缓存认的是整条 URL，
// 所以永远命中不了；而资产本身按“编号 + 内容指纹”是永远不变的，应该按这个键存。
// 为什么不用 IndexedDB：工作台已经把任务记录放在 localStorage、演示素材放在 IndexedDB，这里只是“最近下载过的几张图”，
// Cache Storage 直接存 Response，读出来就是 Blob，不用再序列化。
//
// 条目放在本站的一个私有路径下（/workbench/_asset-cache/…），不是任何一个真实页面，也不会被当成页面请求到。
// 数量有上限（默认 40 张，约一次工作会话），超过就先删最旧的；Cache Storage 按插入顺序列出 keys。

import type { BlobStore } from "./asset-loader";

/** Cache 接口里我们用到的那几个方法（真实的 Cache 对象满足它；测试用 Map 实现）。 */
export type CacheLike = {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<Array<{ url: string }>>;
};
export type CacheBlobStore = BlobStore & { clear(): Promise<void> };

const PATH = "/workbench/_asset-cache/";
export const DEFAULT_MAX_ENTRIES = 40;

export function cacheBlobStore(open: () => Promise<CacheLike>, options: { origin: string; maxEntries?: number }): CacheBlobStore {
  const prefix = options.origin + PATH, max = options.maxEntries ?? DEFAULT_MAX_ENTRIES, urlOf = (key: string) => prefix + key;
  return {
    async get(key) {
      const cache = await open(), found = await cache.match(urlOf(key));
      return found ? await found.blob() : undefined;
    },
    async put(key, blob) {
      const cache = await open();
      await cache.put(urlOf(key), new Response(blob, { headers: { "Content-Type": blob.type || "image/png" } }));
      const ours = (await cache.keys()).filter(entry => entry.url.startsWith(prefix));
      for (const stale of ours.slice(0, Math.max(0, ours.length - max))) await cache.delete(stale.url);
    },
    async clear() {
      const cache = await open();
      for (const entry of (await cache.keys()).filter(item => item.url.startsWith(prefix))) await cache.delete(entry.url);
    },
  };
}
