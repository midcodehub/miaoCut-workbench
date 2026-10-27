"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Locale } from "@/domain/contracts";
import {
  BRUSH, FEATHER, MAX_COLORS, STARTER_COLORS, accumulateLightness, addStroke, buildTable, clearStrokes, coverageOf, emptyEdit, featherRadius, featherSteps,
  meanLightness, normalizeColors, recolorPixels, redo, undo, type EditState, type LightnessSum, type Stroke,
} from "@/domain/recolor";
import { ASSET_BASE, AssetError } from "./assets";
import { MAX_IMAGE_BYTES } from "./idb";
import { encodePng, inSlices, loadSource, proxyMask, renderMask, yieldToBrowser, type LoadedSource } from "./recolor-engine";
import { clearRecolorHandoff, readRecolor, readRecolorHandoff, saveSettings, saveSource } from "./recolor-store";

export type RecolorNotice = "storage_error" | "file_type" | "file_size" | "image_size" | "image_decode" | "stroke_limit" | "export_failed" | null;
/** 涂抹范围算好之后的汇总：sourceL 是被涂抹区域的平均明度（null 表示没有涂到任何可见像素）；coverage 是涂抹面积占比。 */
export interface Prepared { stamp: number; sourceL: number | null; coverage: number }
/** 一个颜色的缩略图（在缩小后的底图上换色得到）。 */
export interface Variant { color: string; thumb: ImageData }
/** 与 Prepared 配套的遮罩数据，体积大，不放进 React state。source 用来确认遮罩属于当前这张底图。 */
interface MaskState { stamp: number; source: LoadedSource; mask: Uint8Array; proxy: Uint8Array }

/** stage 是主画布（由页面组件持有，这个 hook 把换色结果画到上面）。 */
export function useRecolor(stage: RefObject<HTMLCanvasElement | null>) {
  const [source, setSource] = useState<LoadedSource>();
  const [edit, setEdit] = useState<EditState>(emptyEdit);
  const [colors, setColors] = useState<string[]>(STARTER_COLORS), [selected, setSelected] = useState(0);
  const [brush, setBrush] = useState<number>(BRUSH.initial), [feather, setFeather] = useState<number>(FEATHER.initial), [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false), [fromResult, setFromResult] = useState(false);
  const [locale, setLocaleState] = useState<Locale>("zh"), [dark, setDark] = useState(false);
  const [notice, setNotice] = useState<RecolorNotice>(null);
  const [prepared, setPrepared] = useState<Prepared>(), [variants, setVariants] = useState<Variant[]>([]);
  const [preparing, setPreparing] = useState(false), [painting, setPainting] = useState(false);
  const maskState = useRef<MaskState | null>(null), stamps = useRef(0);
  // 全分辨率结果的工作缓冲区，每张底图一份，反复使用，避免每换一次颜色就分配几十 MB。
  const scratch = useRef<{ source: LoadedSource; image: ImageData } | null>(null);
  // 已经套用到当前工程、但还没保存成功的交接记录。保存成功后才从待取区删除（见 readHandoffRecord 的说明）。
  const appliedHandoff = useRef<number | null>(null);

  const noticeFor = (error: unknown): RecolorNotice => (error instanceof AssetError ? error.code : "image_decode");

  // 启动：恢复上次的底图和编辑，再套用“从结果页带过来”的图（它是新底图，旧的涂抹作废）。
  useEffect(() => {
    let active = true;
    async function restore() {
      let saved: Awaited<ReturnType<typeof readRecolor>> = {}, handoff: Awaited<ReturnType<typeof readRecolorHandoff>>, failure: RecolorNotice = null;
      try { saved = await readRecolor(); } catch { failure = "storage_error"; }
      try { handoff = await readRecolorHandoff(); } catch { failure = "storage_error"; }
      let stored: string | null = null;
      try { stored = localStorage.getItem("mc.workbench.locale") ?? localStorage.getItem("lang"); } catch { /* 语言偏好是可选的 */ }
      const initialLocale: Locale = stored === "en" ? "en" : "zh";
      let loaded: LoadedSource | undefined, settings = saved.settings, applied: number | null = null;
      if (handoff) {
        try { loaded = await loadSource(handoff.blob, handoff.name, MAX_IMAGE_BYTES); settings = undefined; applied = handoff.stamp; }
        catch { /* 带过来的图无法使用：继续用原来的底图 */ }
      }
      if (!loaded && saved.source) {
        try { loaded = await loadSource(saved.source.blob, saved.source.name, MAX_IMAGE_BYTES); }
        catch (error) { failure = noticeFor(error); settings = undefined; }
      }
      if (!active) return;
      const palette = settings ? settings.colors : STARTER_COLORS;
      setSource(loaded); setEdit({ strokes: loaded && settings ? settings.strokes : [], undone: [] });
      setColors(palette); setSelected(settings ? Math.min(settings.selected, Math.max(0, palette.length - 1)) : 0);
      if (settings) { setBrush(settings.brush); setFeather(settings.feather); }
      appliedHandoff.current = applied; setFromResult(applied !== null);
      setLocaleState(initialLocale); document.documentElement.lang = initialLocale === "zh" ? "zh-CN" : "en";
      setDark(document.documentElement.classList.contains("dark"));
      if (failure) setNotice(failure);
      setReady(true);
    }
    void restore();
    return () => { active = false; };
  }, []);

  // 第一步：涂抹范围变了（或换了底图、改了柔化）→ 重新生成遮罩、求被涂抹区域的平均明度。稍等一下再算，连续涂抹时不会每一笔都重算。
  useEffect(() => {
    if (!ready || !source) return;
    let cancelled = false;
    const { strokes } = edit, { width, height, original } = source;
    const timer = setTimeout(async () => {
      setPreparing(true);
      try {
        await yieldToBrowser();
        if (cancelled) return;
        const stamp = ++stamps.current;
        if (strokes.length === 0) {
          maskState.current = null; setPrepared({ stamp, sourceL: null, coverage: 0 });
          return;
        }
        const raw = renderMask(strokes, width, height), coverage = coverageOf(raw);
        await yieldToBrowser();
        if (cancelled) return;
        // 柔化分三步做，每步之间让出主线程：大图上一次做完要几百毫秒。
        const steps = featherSteps(raw, width, height, featherRadius(feather, Math.max(width, height)));
        let step = steps.next();
        while (!step.done) { await yieldToBrowser(); if (cancelled) return; step = steps.next(); }
        const mask = step.value;
        const sum: LightnessSum = { sum: 0, weight: 0 };
        if (cancelled || !(await inSlices(() => cancelled, width * height, (start, end) => accumulateLightness(original.data, mask, start, end, sum)))) return;
        maskState.current = { stamp, source, mask, proxy: proxyMask(mask, source) };
        setPrepared({ stamp, sourceL: meanLightness(sum), coverage });
      } catch { if (!cancelled) setNotice("image_decode"); }
      finally { if (!cancelled) setPreparing(false); }
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ready, source, edit, feather]);

  // 第二步：范围、颜色或选中的颜色变了 → 重画缩略图，再把选中的颜色在完整分辨率上算出来画到主画布。
  useEffect(() => {
    const canvas = stage.current;
    if (!ready || !source || !canvas) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const state = maskState.current, color = colors[selected];
      // 涂抹范围必须属于当前这张底图、并且已经算好，才能用来换色；否则主画布显示原图。
      if (!prepared || prepared.sourceL === null || !state || state.stamp !== prepared.stamp || state.source !== source || !color) {
        context.putImageData(source.original, 0, 0); setVariants([]); setPainting(false);
        return;
      }
      const { sourceL } = prepared, { proxy } = source;
      setVariants(colors.map(hex => {
        const table = buildTable(hex, sourceL), data = new ImageData(new Uint8ClampedArray(proxy.data), proxy.width, proxy.height);
        recolorPixels(proxy.data, state.proxy, table, data.data, 0, proxy.width * proxy.height);
        return { color: hex, thumb: data };
      }));
      setPainting(true);
      try {
        if (scratch.current?.source !== source) scratch.current = { source, image: new ImageData(source.width, source.height) };
        const out = scratch.current.image, table = buildTable(color, sourceL);
        out.data.set(source.original.data);
        if (await inSlices(() => cancelled, source.width * source.height, (start, end) => recolorPixels(source.original.data, state.mask, table, out.data, start, end)))
          context.putImageData(out, 0, 0);
      } finally { if (!cancelled) setPainting(false); }
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ready, source, prepared, colors, selected, stage]);

  // 保存：底图只在更换时写一次；编辑状态防抖后写。海报页的做法相同——新底图和编辑都保存成功后才删除待取区。
  useEffect(() => {
    if (!ready || !source) return;
    void saveSource({ blob: source.blob, name: source.name }).catch(() => setNotice("storage_error"));
  }, [ready, source]);
  useEffect(() => {
    if (!ready || !source) return;
    const timer = setTimeout(() => {
      void saveSettings({ strokes: edit.strokes, colors, selected, feather, brush }).then(() => {
        const stamp = appliedHandoff.current;
        if (stamp === null) return;
        appliedHandoff.current = null;
        return clearRecolorHandoff(stamp);
      }).catch(() => setNotice("storage_error"));
    }, 300);
    return () => clearTimeout(timer);
  }, [ready, source, edit.strokes, colors, selected, feather, brush]);

  const replaceSource = useCallback((loaded: LoadedSource) => {
    // 遮罩属于旧底图，换底图后作废；颜色是用户的调色板，保留。
    maskState.current = null; scratch.current = null; appliedHandoff.current = null;
    setSource(loaded); setEdit(emptyEdit()); setPrepared(undefined); setVariants([]); setFromResult(false);
  }, []);
  const uploadSource = useCallback(async (file: File) => {
    setNotice(null);
    try { replaceSource(await loadSource(file, file.name.slice(0, 255))); } catch (error) { setNotice(noticeFor(error)); }
  }, [replaceSource]);
  const useSample = useCallback(async () => {
    setNotice(null);
    try {
      const response = await fetch(`${ASSET_BASE}/sneaker.webp`);
      if (!response.ok) throw new AssetError("image_decode");
      replaceSource(await loadSource(await response.blob(), "sample-sneaker.webp"));
    } catch (error) { setNotice(noticeFor(error)); }
  }, [replaceSource]);

  const commitStroke = useCallback((stroke: Stroke) => {
    const next = addStroke(edit, stroke);
    if (next === edit) setNotice("stroke_limit"); else setEdit(next);
  }, [edit]);
  const undoStroke = useCallback(() => setEdit(current => undo(current)), []);
  const redoStroke = useCallback(() => setEdit(current => redo(current)), []);
  const clearAll = useCallback(() => setEdit(current => clearStrokes(current)), []);

  const addColor = useCallback((hex: string) => {
    const next = normalizeColors([...colors, hex]), index = next.indexOf(hex.toUpperCase());
    if (index < 0) return;
    setColors(next); setSelected(index);
  }, [colors]);
  const changeColor = useCallback((index: number, hex: string) => {
    const upper = hex.toUpperCase();
    if (index < 0 || index >= colors.length || (colors.includes(upper) && colors[index] !== upper)) return; // 与别的颜色重复：忽略
    setColors(normalizeColors(colors.map((color, i) => (i === index ? upper : color))));
  }, [colors]);
  const removeColor = useCallback((index: number) => {
    const next = colors.filter((_, i) => i !== index);
    setColors(next); setSelected(current => Math.max(0, Math.min(next.length - 1, current > index ? current - 1 : current)));
  }, [colors]);

  /** 把某个颜色在完整分辨率上算出来，编码成 PNG。需要涂抹范围已经就绪；算的是新缓冲区，不影响主画布。 */
  const exportVariant = useCallback(async (index: number): Promise<Blob | null> => {
    const state = maskState.current, color = colors[index];
    if (!source || !prepared || prepared.sourceL === null || !state || state.stamp !== prepared.stamp || state.source !== source || !color) return null;
    const table = buildTable(color, prepared.sourceL), out = new ImageData(new Uint8ClampedArray(source.original.data), source.width, source.height);
    await inSlices(() => false, source.width * source.height, (start, end) => recolorPixels(source.original.data, state.mask, table, out.data, start, end));
    try { return await encodePng(out); } catch { setNotice("export_failed"); return null; }
  }, [source, prepared, colors]);

  const setLocale = (value: Locale) => {
    setLocaleState(value); document.documentElement.lang = value === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem("mc.workbench.locale", value); } catch { /* 偏好是可选的 */ }
  };
  const toggleTheme = () => {
    const next = !dark; setDark(next); document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* 偏好是可选的 */ }
  };

  return {
    source, ready, fromResult, dismissFromResult: () => setFromResult(false), notice, setNotice, dismissNotice: () => setNotice(null),
    locale, setLocale, dark, toggleTheme,
    strokes: edit.strokes, canUndo: edit.strokes.length > 0, canRedo: edit.undone.length > 0, commitStroke, undoStroke, redoStroke, clearAll,
    brush, setBrush, feather, setFeather, erase, setErase,
    colors, selected, select: setSelected, addColor, changeColor, removeColor, canAddColor: colors.length < MAX_COLORS,
    prepared, variants, busy: preparing || painting, uploadSource, useSample, exportVariant,
  };
}
