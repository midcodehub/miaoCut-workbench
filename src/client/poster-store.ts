import { validPoster, type PosterDocument } from "@/domain/poster";

// 海报工程和“从结果页带过来的背景图”都存在 IndexedDB：同源的场景工作台页面写入，海报页读取。
const DB = "miaocut-workbench-poster-v1", STORE = "poster";
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_BACKGROUND_BYTES = 32 * 1024 * 1024; // 服务端结果图可能超过 10 MB 的上传上限，这里按结果图的上限放宽
const HANDOFF_MAX_AGE_MS = 60 * 60 * 1000;

export interface StoredPoster { doc: PosterDocument; background?: Blob }
/** stamp 是写入时间，用来在清除时确认删的就是读到的那一条，不会误删后来新写入的。 */
export interface Handoff { blob: Blob; name: string; stamp: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("storage_blocked"));
  });
}
const validBlob = (value: unknown): value is Blob =>
  value instanceof Blob && IMAGE_TYPES.includes(value.type) && value.size > 0 && value.size <= MAX_BACKGROUND_BYTES;

/** 读回上次的工程。记录损坏或背景图丢失时不会让页面崩溃：丢失的图片退回白色纯色背景。 */
export async function readPoster(): Promise<StoredPoster | undefined> {
  const db = await open();
  try {
    const record = await new Promise<{ doc?: unknown; background?: unknown } | undefined>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get("active");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!record || !validPoster(record.doc)) return undefined;
    const background = validBlob(record.background) ? record.background : undefined;
    if (record.doc.background.kind === "image" && !background)
      return { doc: { ...record.doc, background: { kind: "solid", color: "#FFFFFF" } } };
    return { doc: record.doc, background };
  } finally { db.close(); }
}

async function write(key: string, value: unknown): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
// 串行写入：较慢的早期写入不会覆盖后面的新内容。
let pending: Promise<void> = Promise.resolve();
export function savePoster(state: StoredPoster): Promise<void> {
  const next = pending.then(() => write("active", { doc: state.doc, background: state.background }));
  pending = next.catch(() => undefined);
  return next;
}

/** 场景工作台的“做成海报”按钮调用：把结果图放进待取区，然后跳转到海报页。 */
export function writeHandoff(blob: Blob, name: string): Promise<void> {
  const next = pending.then(() => write("handoff", { blob, name: name.slice(0, 255), createdAt: Date.now() }));
  pending = next.catch(() => undefined);
  return next;
}
/**
 * 海报页启动时读取待取区的图片。**只读，不删除**：
 * 如果读到就删，开发模式下 React 会把 effect 执行两次，第一次读走并删除、结果被丢弃，第二次就读不到了，背景永远换不上。
 * 所以要等项目连同新背景成功保存之后，再用 clearHandoff 删除。超过 1 小时的陈旧记录直接忽略。
 */
export async function readHandoff(): Promise<Handoff | undefined> {
  const db = await open();
  try {
    const record = await new Promise<{ blob?: unknown; name?: unknown; createdAt?: unknown } | undefined>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get("handoff");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!record || !validBlob(record.blob) || typeof record.createdAt !== "number" || Date.now() - record.createdAt > HANDOFF_MAX_AGE_MS) return undefined;
    return { blob: record.blob, name: typeof record.name === "string" ? record.name : "result.png", stamp: record.createdAt };
  } finally { db.close(); }
}
/** 删除待取区，但只在它还是 stamp 对应的那一条时才删，避免误删用户刚刚又发来的新结果图。 */
export async function clearHandoff(stamp: number): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite"), store = transaction.objectStore(STORE), request = store.get("handoff");
      request.onsuccess = () => { if (request.result?.createdAt === stamp) store.delete("handoff"); };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
