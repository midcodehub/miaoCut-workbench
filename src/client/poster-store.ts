import { validPoster, type PosterDocument } from "@/domain/poster";
import { MAX_IMAGE_BYTES, clearHandoffRecord, readHandoffRecord, recordStore, validImageBlob, writeHandoffRecord, type Handoff } from "./idb";

// 海报工程和“从结果页带过来的背景图”都存在 IndexedDB：同源的场景工作台页面写入，海报页读取。
const records = recordStore("miaocut-workbench-poster-v1", "poster");
export const MAX_BACKGROUND_BYTES = MAX_IMAGE_BYTES;
export type { Handoff };

export interface StoredPoster { doc: PosterDocument; background?: Blob }

/** 读回上次的工程。记录损坏或背景图丢失时不会让页面崩溃：丢失的图片退回白色纯色背景。 */
export async function readPoster(): Promise<StoredPoster | undefined> {
  const record = await records.get("active") as { doc?: unknown; background?: unknown } | undefined;
  if (!record || !validPoster(record.doc)) return undefined;
  const background = validImageBlob(record.background) ? record.background : undefined;
  if (record.doc.background.kind === "image" && !background)
    return { doc: { ...record.doc, background: { kind: "solid", color: "#FFFFFF" } } };
  return { doc: record.doc, background };
}
export const savePoster = (state: StoredPoster): Promise<void> => records.put("active", { doc: state.doc, background: state.background });

/** 场景工作台的“做成海报”按钮调用：把结果图放进待取区，然后跳转到海报页。 */
export const writeHandoff = (blob: Blob, name: string): Promise<void> => writeHandoffRecord(records, blob, name);
/** 海报页启动时读取待取区的图片（只读，不删除，原因见 readHandoffRecord）。 */
export const readHandoff = (): Promise<Handoff | undefined> => readHandoffRecord(records);
/** 工程连同新背景保存成功后再删除待取区里对应的那一条。 */
export const clearHandoff = (stamp: number): Promise<void> => clearHandoffRecord(records, stamp);
