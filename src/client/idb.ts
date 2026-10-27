/**
 * IndexedDB 的最小封装，海报页和换色页共用：每个页面一个独立的数据库，库里只有一个对象仓库，按字符串键存取。
 * 两个页面都有“从场景工作台的结果页带一张图过来”的交接（handoff），这部分逻辑也放在这里，避免写两份。
 */

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** 服务端结果图可能超过 10 MB 的上传上限，这里按结果图的上限放宽。 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const HANDOFF_MAX_AGE_MS = 60 * 60 * 1000;

export const validImageBlob = (value: unknown): value is Blob =>
  value instanceof Blob && IMAGE_TYPES.includes(value.type) && value.size > 0 && value.size <= MAX_IMAGE_BYTES;

function open(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("storage_blocked"));
  });
}

export interface RecordStore {
  get(key: string): Promise<unknown>;
  /** 串行写入：较慢的早期写入不会覆盖后面的新内容。 */
  put(key: string, value: unknown): Promise<void>;
  /** 读出当前值，只有 predicate 认可时才删除（同一个事务里完成，不会误删中途新写入的内容）。 */
  removeIf(key: string, predicate: (current: unknown) => boolean): Promise<void>;
}

export function recordStore(name: string, store: string): RecordStore {
  let pending: Promise<void> = Promise.resolve();
  async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await open(name, store);
    try { return await run(db); } finally { db.close(); }
  }
  const finished = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return {
    get: key => withDb(db => new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })),
    put(key, value) {
      const next = pending.then(() => withDb(db => {
        const transaction = db.transaction(store, "readwrite");
        transaction.objectStore(store).put(value, key);
        return finished(transaction);
      }));
      pending = next.catch(() => undefined);
      return next;
    },
    removeIf: (key, predicate) => withDb(db => {
      const transaction = db.transaction(store, "readwrite"), objects = transaction.objectStore(store), request = objects.get(key);
      request.onsuccess = () => { if (predicate(request.result)) objects.delete(key); };
      return finished(transaction);
    }),
  };
}

/** stamp 是写入时间，用来在清除时确认删的就是读到的那一条，不会误删后来新写入的。 */
export interface Handoff { blob: Blob; name: string; stamp: number }

/** 场景工作台的结果页调用：把结果图放进待取区，然后跳转到对应页面。 */
export function writeHandoffRecord(records: RecordStore, blob: Blob, name: string): Promise<void> {
  return records.put("handoff", { blob, name: name.slice(0, 255), createdAt: Date.now() });
}
/**
 * 目标页面启动时读取待取区的图片。**只读，不删除**：
 * 如果读到就删，开发模式下 React 会把 effect 执行两次，第一次读走并删除、结果被丢弃，第二次就读不到了，图片永远换不上。
 * 所以要等页面把它连同工程一起保存成功之后，再用 clearHandoffRecord 删除。超过 1 小时的陈旧记录直接忽略。
 */
export async function readHandoffRecord(records: RecordStore): Promise<Handoff | undefined> {
  const record = await records.get("handoff") as { blob?: unknown; name?: unknown; createdAt?: unknown } | undefined;
  if (!record || !validImageBlob(record.blob) || typeof record.createdAt !== "number" || Date.now() - record.createdAt > HANDOFF_MAX_AGE_MS) return undefined;
  return { blob: record.blob, name: typeof record.name === "string" ? record.name : "result.png", stamp: record.createdAt };
}
/** 删除待取区，但只在它还是 stamp 对应的那一条时才删，避免误删用户刚刚又发来的新结果图。 */
export function clearHandoffRecord(records: RecordStore, stamp: number): Promise<void> {
  return records.removeIf("handoff", current => (current as { createdAt?: unknown } | undefined)?.createdAt === stamp);
}
