import { isSticker, validPoster, type PosterDocument } from "@/domain/poster";
import { MAX_IMAGE_BYTES, clearHandoffRecord, readHandoffRecord, recordStore, validImageBlob, writeHandoffRecord, type Handoff } from "./idb";

// 海报工程和“从结果页带过来的背景图”都存在 IndexedDB：同源的场景工作台页面写入，海报页读取。
const records = recordStore("miaocut-workbench-poster-v1", "poster");
export const MAX_BACKGROUND_BYTES = MAX_IMAGE_BYTES;
export type { Handoff };

/** 贴纸的图片像素各存一条记录（键 `sticker:<图层 id>`）：每次拖动只重写几 KB 的工程，不反复写整张图片。 */
const STICKER_PREFIX = "sticker:";
const stickerKey = (id: string) => `${STICKER_PREFIX}${id}`;

export interface StoredPoster { doc: PosterDocument; background?: Blob; stickers: Map<string, Blob> }

/**
 * 读回上次的工程。记录损坏或图片丢失时不会让页面崩溃：丢失的背景图退回白色纯色背景，丢失像素的贴纸从工程里去掉。
 */
export async function readPoster(): Promise<StoredPoster | undefined> {
  const record = await records.get("active") as { doc?: unknown; background?: unknown } | undefined;
  if (!record || !validPoster(record.doc)) return undefined;
  let doc: PosterDocument = record.doc;
  const background = validImageBlob(record.background) ? record.background : undefined;
  if (doc.background.kind === "image" && !background) doc = { ...doc, background: { kind: "solid", color: "#FFFFFF" } };
  const stickers = new Map<string, Blob>();
  for (const layer of doc.layers) {
    if (!isSticker(layer)) continue;
    const stored = await records.get(stickerKey(layer.id)) as { blob?: unknown } | undefined;
    if (stored && validImageBlob(stored.blob)) stickers.set(layer.id, stored.blob);
  }
  if (doc.layers.some(layer => isSticker(layer) && !stickers.has(layer.id))) doc = { ...doc, layers: doc.layers.filter(layer => !isSticker(layer) || stickers.has(layer.id)) };
  return { doc, background, stickers };
}
export const savePoster = (state: Pick<StoredPoster, "doc" | "background">): Promise<void> => records.put("active", { doc: state.doc, background: state.background });

/** 添加贴纸时先写入像素，再让工程引用它：即使中途刷新，也只会留下一条无人引用的记录（下次启动时清理），不会出现引用了却找不到的贴纸。 */
export const saveSticker = (id: string, blob: Blob): Promise<void> => records.put(stickerKey(id), { blob });
export const removeSticker = (id: string): Promise<void> => records.removeIf(stickerKey(id), () => true);
/** 删除没有被工程引用的贴纸记录。只在启动时、用户还不能操作之前调用，所以不会误删刚添加的贴纸。 */
export async function pruneStickers(keep: ReadonlySet<string>): Promise<void> {
  const keys = await records.keys();
  await Promise.all(keys.filter(key => key.startsWith(STICKER_PREFIX) && !keep.has(key.slice(STICKER_PREFIX.length))).map(key => records.removeIf(key, () => true)));
}

/** 场景工作台的“做成海报”按钮调用：把结果图放进待取区，然后跳转到海报页。 */
export const writeHandoff = (blob: Blob, name: string): Promise<void> => writeHandoffRecord(records, blob, name);
/** 海报页启动时读取待取区的图片（只读，不删除，原因见 readHandoffRecord）。 */
export const readHandoff = (): Promise<Handoff | undefined> => readHandoffRecord(records);
/** 工程连同新背景保存成功后再删除待取区里对应的那一条。 */
export const clearHandoff = (stamp: number): Promise<void> => clearHandoffRecord(records, stamp);
