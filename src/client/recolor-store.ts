import { BRUSH, FEATHER, MAX_COLORS, normalizeColors, sanitizeStrokes, type Stroke } from "@/domain/recolor";
import { clearHandoffRecord, readHandoffRecord, recordStore, validImageBlob, writeHandoffRecord, type Handoff } from "./idb";

// 换色页的底图和编辑状态存在 IndexedDB，刷新后可以接着改；场景工作台结果页也往这里的待取区放图。
// 底图（可能有几 MB）和编辑状态分开存：每涂一笔只重写几 KB 的编辑状态，不用反复写整张图。
const records = recordStore("miaocut-workbench-recolor-v1", "recolor");
export type { Handoff };

export interface RecolorSource { blob: Blob; name: string }
export interface RecolorSettings { strokes: Stroke[]; colors: string[]; selected: number; feather: number; brush: number }

const finite = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 读回上次的底图和编辑状态。记录损坏时逐项退回默认值，不会让页面崩溃；没有底图时编辑状态也不使用（遮罩属于底图）。 */
export async function readRecolor(): Promise<{ source?: RecolorSource; settings?: RecolorSettings }> {
  const [source, settings] = await Promise.all([records.get("source"), records.get("settings")]) as
    [{ blob?: unknown; name?: unknown } | undefined, Partial<Record<keyof RecolorSettings, unknown>> | undefined];
  if (!source || !validImageBlob(source.blob)) return {};
  const colors = normalizeColors(Array.isArray(settings?.colors) ? settings.colors : []);
  return {
    source: { blob: source.blob, name: typeof source.name === "string" ? source.name : "image.png" },
    settings: settings ? {
      strokes: sanitizeStrokes(settings.strokes), colors,
      selected: Math.round(finite(settings.selected, 0, 0, Math.max(0, MAX_COLORS - 1))),
      feather: finite(settings.feather, FEATHER.initial, 0, FEATHER.max), brush: finite(settings.brush, BRUSH.initial, BRUSH.min, BRUSH.max),
    } : undefined,
  };
}
export const saveSource = (source: RecolorSource): Promise<void> => records.put("source", { blob: source.blob, name: source.name.slice(0, 255) });
export const saveSettings = (settings: RecolorSettings): Promise<void> => records.put("settings", settings);

/** 场景工作台结果页的“精确换色”按钮调用：把结果图放进待取区，然后跳转到换色页。 */
export const writeRecolorHandoff = (blob: Blob, name: string): Promise<void> => writeHandoffRecord(records, blob, name);
/** 换色页启动时读取待取区的图片（只读，不删除，原因见 readHandoffRecord）。 */
export const readRecolorHandoff = (): Promise<Handoff | undefined> => readHandoffRecord(records);
/** 底图和编辑状态都保存成功后再删除待取区里对应的那一条。 */
export const clearRecolorHandoff = (stamp: number): Promise<void> => clearHandoffRecord(records, stamp);
