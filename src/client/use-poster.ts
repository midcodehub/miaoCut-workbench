"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale } from "@/domain/contracts";
import {
  addSticker as addStickerLayer, addText, emptyPoster, isSticker, isText, moveLayer, removeLayer, setBackground, updateLayer, updateSticker,
  MAX_STICKERS, MAX_TEXT_LAYERS, type PosterDocument, type TextLayer,
} from "@/domain/poster";
import { AssetError, imageFromUrl } from "./assets";
import { MAX_BACKGROUND_BYTES, clearHandoff, pruneStickers, readHandoff, readPoster, removeSticker, savePoster, saveSticker } from "./poster-store";
import { StickerError, decodeSticker, loadSticker, makeSampleSticker } from "./sticker-image";

export type PosterNotice = "storage_error" | "file_type" | "file_size" | "image_size" | "image_decode" | "sticker_file_type" | "sticker_no_alpha" | "sticker_empty" | "sticker_limit" | null;
/** 一张贴纸的图片：原始文件（用于缩略图）和解码好的图片元素（用于绘制）。 */
export interface StickerAsset { blob: Blob; image: HTMLImageElement }
const UPLOAD_LIMIT = 10 * 1024 * 1024;

/** 解码图片取得真实尺寸，同时校验类型、字节数和像素数。 */
async function inspectImage(blob: Blob, limit: number): Promise<{ width: number; height: number }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new AssetError("file_type");
  if (blob.size > limit) throw new AssetError("file_size");
  const url = URL.createObjectURL(blob);
  try {
    const image = await imageFromUrl(url), width = image.naturalWidth, height = image.naturalHeight;
    if (width * height > 16_777_216) throw new AssetError("image_size");
    return { width, height };
  } finally { URL.revokeObjectURL(url); }
}

/** 首次打开时放两个示例文字框，方便直接看到效果；之后的内容都来自用户自己的编辑。 */
function starter(locale: Locale): PosterDocument {
  const zh = locale === "zh";
  let doc = emptyPoster(crypto.randomUUID());
  doc = addText(doc, crypto.randomUUID(), zh ? "新品上市" : "New arrival", { box: [0.08, 0.08, 0.92, 0.24], weight: 700 });
  doc = addText(doc, crypto.randomUUID(), zh ? "在这里写卖点\n价格也直接写在文字里" : "Write the selling point here\nPut the price in the text too",
    { box: [0.08, 0.26, 0.7, 0.4], weight: 400, color: "#4B5563" });
  return doc;
}

export function usePoster() {
  // 文档和当前选中的图层放在同一个 state 里，一次更新同时改两者，更新函数保持纯函数。
  const [{ doc, selectedId }, setState] = useState<{ doc: PosterDocument; selectedId: string | null }>(
    () => ({ doc: emptyPoster(crypto.randomUUID()), selectedId: null }));
  const [background, setBackgroundBlob] = useState<Blob>();
  const [stickers, setStickers] = useState<ReadonlyMap<string, StickerAsset>>(() => new Map());
  const [loaded, setLoaded] = useState<{ blob: Blob; image: HTMLImageElement }>();
  const [ready, setReady] = useState(false), [fromResult, setFromResult] = useState(false);
  const [locale, setLocaleState] = useState<Locale>("zh"), [dark, setDark] = useState(false);
  const [notice, setNotice] = useState<PosterNotice>(null);
  // 已经套用到当前工程、但还没保存成功的交接记录。保存成功后才从待取区删除（见 readHandoff 的说明）。
  const appliedHandoff = useRef<number | null>(null);

  // 启动：恢复上次工程，再套用“从结果页带过来”的背景图（只换背景，文字保持不变）。
  useEffect(() => {
    let active = true;
    async function restore() {
      let saved: Awaited<ReturnType<typeof readPoster>>, handoff: Awaited<ReturnType<typeof readHandoff>>, storageFailed = false;
      try { saved = await readPoster(); } catch { storageFailed = true; }
      try { handoff = await readHandoff(); } catch { storageFailed = true; }
      let stored: string | null = null;
      try { stored = localStorage.getItem("mc.workbench.locale") ?? localStorage.getItem("lang"); } catch { /* 语言偏好是可选的 */ }
      const initialLocale: Locale = stored === "en" ? "en" : "zh";
      let next = saved?.doc ?? starter(initialLocale), blob = saved?.background, applied: number | null = null;
      // 贴纸：像素解码失败的整张去掉；清理没有被工程引用的像素记录（此时用户还不能操作，不会误删刚添加的）。
      const assets = new Map<string, StickerAsset>();
      for (const [id, stickerBlob] of saved?.stickers ?? []) {
        try { assets.set(id, { blob: stickerBlob, image: await decodeSticker(stickerBlob) }); } catch { /* 无法解码的贴纸从工程里去掉 */ }
      }
      if (next.layers.some(layer => isSticker(layer) && !assets.has(layer.id))) next = { ...next, layers: next.layers.filter(layer => !isSticker(layer) || assets.has(layer.id)) };
      if (!storageFailed) { try { await pruneStickers(new Set(assets.keys())); } catch { /* 清理失败不影响使用，下次启动再试 */ } }
      if (handoff) {
        try {
          const size = await inspectImage(handoff.blob, MAX_BACKGROUND_BYTES);
          next = setBackground(next, { kind: "image", source: "result", name: handoff.name, ...size }); blob = handoff.blob; applied = handoff.stamp;
        } catch { /* 带过来的图片无法使用：保留原来的背景 */ }
      }
      if (!active) return;
      setState({ doc: next, selectedId: next.layers[0]?.id ?? null }); setBackgroundBlob(blob); setStickers(assets);
      appliedHandoff.current = applied; setFromResult(applied !== null); setLocaleState(initialLocale); document.documentElement.lang = initialLocale === "zh" ? "zh-CN" : "en";
      setDark(document.documentElement.classList.contains("dark"));
      if (storageFailed) setNotice("storage_error");
      setReady(true);
    }
    void restore();
    return () => { active = false; };
  }, []);

  // 背景图解码成 HTMLImageElement 供 Canvas 使用。图片和 Blob 绑定记录，避免换图过程中误用旧图导出。
  useEffect(() => {
    if (!background) return;
    let active = true;
    const url = URL.createObjectURL(background);
    void imageFromUrl(url).finally(() => URL.revokeObjectURL(url)).then(image => { if (active) setLoaded({ blob: background, image }); })
      .catch(() => { if (active) setNotice("image_decode"); });
    return () => { active = false; };
  }, [background]);
  const image = loaded && loaded.blob === background ? loaded.image : undefined;

  // 防抖保存：拖动文本框时每帧都在改，不必每帧写 IndexedDB。
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void savePoster({ doc, background }).then(() => {
        // 新背景已经随工程保存，这时才可以删除待取区里的那一条。
        const stamp = appliedHandoff.current;
        if (stamp === null) return;
        appliedHandoff.current = null;
        return clearHandoff(stamp);
      }).catch(() => setNotice("storage_error"));
    }, 250);
    return () => clearTimeout(timer);
  }, [doc, background, ready]);

  // 领域函数在“无法执行或没有变化”时返回同一个文档对象，这里据此原样返回旧 state，避免无意义的重渲染和保存。
  const change = useCallback((edit: (doc: PosterDocument) => PosterDocument) =>
    setState(state => { const next = edit(state.doc); return next === state.doc ? state : { ...state, doc: next }; }), []);
  const addLayer = useCallback(() => {
    const id = crypto.randomUUID(), text = locale === "zh" ? "输入文字" : "Your text";
    setState(state => { const next = addText(state.doc, id, text); return next === state.doc ? state : { doc: next, selectedId: id }; });
  }, [locale]);
  const patchLayer = useCallback((id: string, patch: Partial<Omit<TextLayer, "kind" | "id">>) => change(current => updateLayer(current, id, patch)), [change]);
  const deleteLayer = useCallback((id: string) => {
    const target = doc.layers.find(layer => layer.id === id);
    if (target && isSticker(target)) {
      // 贴纸的像素和图层一起删除（先从界面移除，再清理存储；清理失败只会留下一条下次启动时被清掉的记录）。
      setStickers(current => { const next = new Map(current); next.delete(id); return next; });
      void removeSticker(id).catch(() => undefined);
    }
    setState(state => {
      const index = state.doc.layers.findIndex(layer => layer.id === id), next = removeLayer(state.doc, id);
      if (next === state.doc) return state;
      // 删除的是当前选中的图层时，改选相邻的一层，方便连续整理。
      const selectedId = state.selectedId !== id ? state.selectedId : next.layers[Math.min(index, next.layers.length - 1)]?.id ?? null;
      return { doc: next, selectedId };
    });
  }, [doc]);
  const reorder = useCallback((id: string, direction: "up" | "down") => change(current => moveLayer(current, id, direction)), [change]);
  const select = useCallback((id: string | null) => setState(state => (state.selectedId === id ? state : { ...state, selectedId: id })), []);
  const setColor = useCallback((color: string) => {
    change(current => setBackground(current, { kind: "solid", color: color.toUpperCase() })); setBackgroundBlob(undefined); setFromResult(false);
  }, [change]);
  const uploadBackground = useCallback(async (file: File) => {
    setNotice(null);
    try {
      const size = await inspectImage(file, UPLOAD_LIMIT);
      change(current => setBackground(current, { kind: "image", source: "upload", name: file.name.slice(0, 255), ...size }));
      setBackgroundBlob(file); setFromResult(false);
    } catch (error) { setNotice(error instanceof AssetError ? error.code : "image_decode"); }
  }, [change]);

  // 添加贴纸：先校验并解码，再把像素写进存储，最后才让工程引用它。存储失败时仍可在本次编辑中使用（提示无法保存）。
  const addStickerFile = useCallback(async (file: File) => {
    setNotice(null);
    if (doc.layers.filter(isSticker).length >= MAX_STICKERS) { setNotice("sticker_limit"); return; }
    try {
      const { image, width, height } = await loadSticker(file), id = crypto.randomUUID();
      try { await saveSticker(id, file); } catch { setNotice("storage_error"); }
      setStickers(current => new Map(current).set(id, { blob: file, image }));
      setState(state => {
        const next = addStickerLayer(state.doc, id, { name: file.name, width, height });
        return next === state.doc ? state : { doc: next, selectedId: id };
      });
    } catch (error) { setNotice(error instanceof StickerError ? (error.code === "file_type" ? "sticker_file_type" : error.code) : "image_decode"); }
  }, [doc]);
  const addSampleSticker = useCallback(async () => {
    try { await addStickerFile(await makeSampleSticker()); } catch { setNotice("image_decode"); }
  }, [addStickerFile]);
  const patchSticker = useCallback((id: string, patch: { cx?: number; cy?: number; width?: number; rotation?: number }) =>
    change(current => updateSticker(current, id, patch)), [change]);

  const setLocale = (value: Locale) => {
    setLocaleState(value); document.documentElement.lang = value === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem("mc.workbench.locale", value); } catch { /* 偏好是可选的 */ }
  };
  const toggleTheme = () => {
    const next = !dark; setDark(next); document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* 偏好是可选的 */ }
  };
  const selected = useMemo(() => doc.layers.find(layer => layer.id === selectedId) ?? null, [doc.layers, selectedId]);
  return { doc, image, background, ready, fromResult, dismissFromResult: () => setFromResult(false), notice, dismissNotice: () => setNotice(null),
    locale, setLocale, dark, toggleTheme, selectedId, selected, select, addLayer, patchLayer, deleteLayer, reorder,
    setColor, uploadBackground, canAdd: doc.layers.filter(isText).length < MAX_TEXT_LAYERS,
    stickers, addStickerFile, addSampleSticker, patchSticker, canAddSticker: doc.layers.filter(isSticker).length < MAX_STICKERS };
}
