"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Eraser, ImagePlus, LoaderCircle, Moon, Paintbrush, Plus, Redo2, Scissors, Sun, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import { downloadPng } from "@/client/assets";
import { MAX_IMAGE_BYTES } from "@/client/idb";
import { writeHandoff } from "@/client/poster-store";
import { drawStroke, overlaySize } from "@/client/recolor-engine";
import { useRecolor } from "@/client/use-recolor";
import { BRUSH, FEATHER, MAX_COLORS, MAX_POINTS, PRESET_COLORS, brushRadius, isWideShift, type Stroke } from "@/domain/recolor";
import { BlobImage } from "./blob-image";

const copy = {
  zh: {
    title: "精确换色", intro: "用画笔涂出要换色的区域，选几个颜色，立刻看到效果。换色在你的浏览器里完成：保留原来的明暗和纹理，涂抹范围以外的像素一点不变，免费，不上传图片。",
    sourceTitle: "底图", upload: "上传图片", replace: "更换图片", sample: "使用示例图", sourceHint: "支持 PNG、JPG、WebP，10 MB 以内、不超过 1600 万像素。图片和编辑只保存在当前浏览器。",
    fromResult: "已把场景结果设为底图，之前的涂抹已清除。", toolTitle: "画笔", brush: "画笔", eraser: "橡皮", size: "大小", soften: "边缘柔化",
    undo: "撤销", redo: "重做", clear: "清除涂抹", area: (percent: string) => `涂抹面积 ${percent}`, showRange: "显示涂抹范围",
    canvas: "换色预览", hintEmpty: "用画笔涂抹要换色的区域", hintNoImage: "先上传一张图片，或使用示例图", loading: "正在准备", working: "正在计算", ready: "已就绪",
    colorsTitle: "颜色", addColor: "添加颜色", limit: `最多 ${MAX_COLORS} 个颜色`, presets: "常用色", editColor: "当前颜色", remove: "删除这个颜色", download: "下载这个颜色",
    wide: "明暗跨度较大，原来的纹理会变淡。可以换一个明暗更接近的颜色。", noColors: "还没有颜色。点击“添加颜色”。",
    needRange: "先涂抹要换色的区域，颜色预览会出现在这里。", exportPng: "下载 PNG", exportPoster: "做成海报", exporting: "正在导出",
    exportHint: "原图尺寸 · PNG · 在你的浏览器里生成", privacy: "图片和编辑只保存在当前浏览器，不会上传",
    file_type: "请选择 PNG、JPG 或 WebP 图片。", file_size: "图片超过 10 MB，请换一张较小的图片。", image_size: "图片像素过大，请使用不超过 1600 万像素的图片。",
    image_decode: "图片无法读取，请重新选择。", storage_error: "浏览器暂时无法保存编辑，可以继续使用并下载。", stroke_limit: "涂抹的笔画已达上限，请撤销或清除一部分后再涂。",
    export_failed: "导出失败，请重试。", posterTooLarge: "图片太大，无法带到海报页。请先下载，再在海报页上传。",
    back: "返回场景工作台", poster: "做海报", dismiss: "关闭提示", switchDark: "切换深色模式", switchLight: "切换浅色模式", language: "Switch to English",
    paintLabel: "在图片上涂抹要换色的区域", pointerNote: "涂抹需要鼠标、触控笔或手指。",
  },
  en: {
    title: "Exact recolour", intro: "Paint over the area to recolour, pick a few colours and see them at once. Recolouring runs in your browser: it keeps the original light and texture, leaves every pixel outside your strokes untouched, is free, and never uploads the image.",
    sourceTitle: "Image", upload: "Upload an image", replace: "Replace image", sample: "Use the sample image", sourceHint: "PNG, JPG or WebP, up to 10 MB and 16 million pixels. Images and edits stay in this browser.",
    fromResult: "A scene result is now the image. Earlier strokes were cleared.", toolTitle: "Brush", brush: "Brush", eraser: "Eraser", size: "Size", soften: "Edge softness",
    undo: "Undo", redo: "Redo", clear: "Clear strokes", area: (percent: string) => `Painted area ${percent}`, showRange: "Show painted area",
    canvas: "Recolour preview", hintEmpty: "Paint the area you want to recolour", hintNoImage: "Upload an image or use the sample first", loading: "Preparing", working: "Calculating", ready: "Ready",
    colorsTitle: "Colours", addColor: "Add a colour", limit: `Up to ${MAX_COLORS} colours`, presets: "Common colours", editColor: "Current colour", remove: "Remove this colour", download: "Download this colour",
    wide: "This is a big jump in lightness, so the original texture will look flatter. Try a colour closer in lightness.", noColors: "No colours yet. Choose “Add a colour”.",
    needRange: "Paint the area to recolour first. Colour previews appear here.", exportPng: "Download PNG", exportPoster: "Make a poster", exporting: "Exporting",
    exportHint: "Original size · PNG · generated in your browser", privacy: "Images and edits stay in this browser and are never uploaded",
    file_type: "Choose a PNG, JPG or WebP image.", file_size: "The image is over 10 MB. Choose a smaller one.", image_size: "The image has too many pixels. Use one under 16 million.",
    image_decode: "The image could not be read. Choose another.", storage_error: "The browser cannot save your edits right now. You can keep working and download.", stroke_limit: "You have reached the stroke limit. Undo or clear some strokes first.",
    export_failed: "Export failed. Please try again.", posterTooLarge: "The image is too large to send to the poster page. Download it and upload it there.",
    back: "Back to scene workspace", poster: "Poster", dismiss: "Dismiss", switchDark: "Switch to dark mode", switchLight: "Switch to light mode", language: "切换为中文",
    paintLabel: "Paint the area to recolour on the image", pointerNote: "Painting needs a mouse, pen or finger.",
  },
};

/** 把一块 ImageData 画到小画布上，用于每个颜色的缩略图。 */
function Thumb({ data }: { data: ImageData }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => { canvas.current?.getContext("2d")?.putImageData(data, 0, 0); }, [data]);
  return <canvas ref={canvas} width={data.width} height={data.height} aria-hidden="true" />;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** 下载文件名：原文件名去掉扩展名，加上颜色值。 */
const fileName = (name: string, hex: string) => `${name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "image"}-${hex.slice(1).toLowerCase()}.png`;

export function RecolorWorkbench() {
  const stage = useRef<HTMLCanvasElement>(null), app = useRecolor(stage), router = useRouter();
  const { source, locale, prepared } = app, c = copy[locale];
  const fileInput = useRef<HTMLInputElement>(null), overlay = useRef<HTMLCanvasElement>(null), cursor = useRef<HTMLDivElement>(null);
  const drawing = useRef<{ pointer: number; stroke: Stroke } | null>(null);
  const [showRange, setShowRange] = useState(true), [exporting, setExporting] = useState<number | "poster" | null>(null), [posterTooLarge, setPosterTooLarge] = useState(false);
  const view = source ? overlaySize(source.width, source.height) : { width: 1, height: 1 };
  const hasRange = !!prepared && prepared.sourceL !== null;
  const canExport = app.ready && !app.busy && hasRange && exporting === null;

  // 涂抹层：笔画变化（撤销、重做、清除、提交）后整体重画，保证与全分辨率遮罩的形状一致。
  useEffect(() => {
    const target = overlay.current, context = target?.getContext("2d");
    if (!target || !context) return;
    context.clearRect(0, 0, target.width, target.height);
    for (const stroke of app.strokes) drawStroke(context, stroke, target.width, target.height, "overlay");
  }, [app.strokes, view.width, view.height, source]);

  const position = (event: { clientX: number; clientY: number }): [number, number] | null => {
    const bounds = overlay.current?.getBoundingClientRect();
    return bounds && bounds.width > 0 ? [clamp01((event.clientX - bounds.left) / bounds.width), clamp01((event.clientY - bounds.top) / bounds.height)] : null;
  };
  const moveCursor = (event: React.PointerEvent<HTMLElement>) => {
    const ring = cursor.current, bounds = overlay.current?.getBoundingClientRect();
    if (!ring || !bounds) return;
    const diameter = brushRadius(app.brush) * 2 * Math.max(bounds.width, bounds.height);
    ring.style.cssText = `display:${event.pointerType === "touch" ? "none" : "block"};left:${event.clientX - bounds.left}px;top:${event.clientY - bounds.top}px;width:${diameter}px;height:${diameter}px`;
  };
  const hideCursor = () => { if (cursor.current) cursor.current.style.display = "none"; };
  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = position(event), context = overlay.current?.getContext("2d");
    if (event.button !== 0 || !point || !context || !app.ready) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: Stroke = { erase: app.erase, radius: brushRadius(app.brush), points: [point[0], point[1]] };
    drawing.current = { pointer: event.pointerId, stroke };
    setShowRange(true);
    drawStroke(context, stroke, overlay.current!.width, overlay.current!.height, "overlay");
  };
  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    const current = drawing.current, target = overlay.current, context = target?.getContext("2d"), bounds = target?.getBoundingClientRect();
    if (!current || current.pointer !== event.pointerId || !target || !context || !bounds) return;
    // 浏览器合并了的中间位置也取出来，快速拖动时笔画才平滑；不支持时只用当前位置。
    const native = event.nativeEvent, samples = native.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length > 0 ? samples : [native]) {
      const point = position(sample), { points } = current.stroke;
      if (!point || points.length / 2 >= MAX_POINTS) continue;
      const lastX = points[points.length - 2], lastY = points[points.length - 1];
      // 离上一个点不到 1.5 个屏幕像素的移动忽略，笔画点数少得多，看不出区别。
      if (Math.hypot((point[0] - lastX) * bounds.width, (point[1] - lastY) * bounds.height) < 1.5) continue;
      points.push(point[0], point[1]);
      drawStroke(context, { ...current.stroke, points: [lastX, lastY, point[0], point[1]] }, target.width, target.height, "overlay");
    }
  };
  const onUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = drawing.current;
    if (!current || current.pointer !== event.pointerId) return;
    drawing.current = null;
    app.commitStroke(current.stroke);
  };

  // Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做；在输入框里不拦截。
  const { undoStroke, redoStroke } = app;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!(event.metaKey || event.ctrlKey) || target?.closest("input, textarea, select")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { event.preventDefault(); undoStroke(); }
      else if ((key === "z" && event.shiftKey) || key === "y") { event.preventDefault(); redoStroke(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoStroke, redoStroke]);

  const download = useCallback(async (index: number) => {
    if (!source || exporting !== null) return;
    setExporting(index);
    try { const blob = await app.exportVariant(index); if (blob) downloadPng(blob, fileName(source.name, app.colors[index])); }
    finally { setExporting(null); }
  }, [app, source, exporting]);
  const makePoster = async () => {
    if (!source || exporting !== null) return;
    setExporting("poster"); setPosterTooLarge(false);
    try {
      const blob = await app.exportVariant(app.selected);
      if (!blob) return;
      if (blob.size > MAX_IMAGE_BYTES) { setPosterTooLarge(true); return; }
      await writeHandoff(blob, fileName(source.name, app.colors[app.selected]));
      router.push("/poster"); // basePath（/workbench）由路由自动补上
    } catch { app.setNotice("storage_error"); }
    finally { setExporting(null); }
  };

  const color = app.colors[app.selected], coverage = prepared ? `${(prepared.coverage * 100).toFixed(prepared.coverage < 0.1 ? 1 : 0)}%` : "—";
  const wide = hasRange && !!color && isWideShift(prepared!.sourceL!, color);
  const status = !app.ready ? c.loading : app.busy ? c.working : c.ready;
  return <div className="workbench-app recolor-app">
    <header className="site-header"><div className="header-content">
      <a href="https://miaocut.app" className="brand-link" aria-label="MiaoCut"><span className="brand-mark"><Scissors size={19} strokeWidth={1.7} /></span>MiaoCut</a>
      <span className="header-divider" /><span className="header-workspace">{c.title}</span>
      <div className="header-actions"><a className="header-link" href="/workbench/poster">{c.poster}</a><a className="header-link" href="/workbench/product"><ArrowLeft size={13} />{c.back}</a>
        <button type="button" className="icon-button language-button" aria-label={c.language} onClick={() => app.setLocale(locale === "zh" ? "en" : "zh")}>{locale === "zh" ? "EN" : "中"}</button>
        <button type="button" className="icon-button" aria-label={app.dark ? c.switchLight : c.switchDark} onClick={app.toggleTheme}>{app.dark ? <Sun size={18} /> : <Moon size={18} />}</button>
      </div>
    </div></header>
    <main className="workspace-main">
      <div className="page-heading"><div><h1>{c.title}</h1><p>{c.intro}</p></div></div>
      {app.notice ? <div className="error-notice" role="alert"><span>{c[app.notice]}</span>
        <button type="button" className="icon-button" aria-label={c.dismiss} onClick={app.dismissNotice}><X size={16} /></button></div> : null}
      {posterTooLarge ? <div className="error-notice" role="alert"><span>{c.posterTooLarge}</span>
        <button type="button" className="icon-button" aria-label={c.dismiss} onClick={() => setPosterTooLarge(false)}><X size={16} /></button></div> : null}
      {app.fromResult ? <div className="demo-notice" role="status"><span>{c.fromResult}</span>
        <button type="button" onClick={app.dismissFromResult}>{c.dismiss}</button></div> : null}

      <div className="workspace-grid">
        <aside className="side-panel" aria-label={c.sourceTitle}>
          <div className="panel-section">
            <div className="section-title"><h2>{c.sourceTitle}</h2><ImagePlus size={16} /></div>
            <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={c.upload}
              onChange={event => { const file = event.target.files?.[0]; if (file) void app.uploadSource(file); event.currentTarget.value = ""; }} />
            <button type="button" className="upload-zone" disabled={!app.ready} onClick={() => fileInput.current?.click()}>
              {source ? <span className="asset-thumbnail checkerboard"><BlobImage blob={source.blob} alt="" /></span> : <ImagePlus size={24} />}
              <span className="upload-zone-label">{source ? c.replace : c.upload}</span></button>
            <button type="button" className="sample-button" disabled={!app.ready} onClick={() => void app.useSample()}>{c.sample}</button>
            <p className="control-help">{c.sourceHint}</p>
          </div>
          <div className="panel-section recolor-tools">
            <div className="section-title"><h2>{c.toolTitle}</h2></div>
            <div className="poster-segment" role="group" aria-label={c.toolTitle}>
              <button type="button" aria-pressed={!app.erase} onClick={() => app.setErase(false)}><Paintbrush size={13} /> {c.brush}</button>
              <button type="button" aria-pressed={app.erase} onClick={() => app.setErase(true)}><Eraser size={13} /> {c.eraser}</button></div>
            <label className="poster-field"><span>{c.size}<small>{app.brush}</small></span>
              <input type="range" className="recolor-slider" min={BRUSH.min} max={BRUSH.max} step={1} value={app.brush} onChange={event => app.setBrush(Number(event.target.value))} /></label>
            <label className="poster-field"><span>{c.soften}<small>{app.feather}</small></span>
              <input type="range" className="recolor-slider" min={0} max={FEATHER.max} step={1} value={app.feather} onChange={event => app.setFeather(Number(event.target.value))} /></label>
            <div className="recolor-history">
              <button type="button" className="subtle-button" disabled={!app.canUndo} onClick={app.undoStroke}><Undo2 size={14} />{c.undo}</button>
              <button type="button" className="subtle-button" disabled={!app.canRedo} onClick={app.redoStroke}><Redo2 size={14} />{c.redo}</button></div>
            <button type="button" className="sample-button" disabled={!app.canUndo} onClick={app.clearAll}><Trash2 size={13} />{c.clear}</button>
            <p className="control-help">{c.area(coverage)}</p><p className="control-help">{c.pointerNote}</p>
          </div>
        </aside>

        <section className="canvas-panel" aria-label={c.canvas}>
          <div className="canvas-toolbar"><span>{c.canvas}</span>
            <label className="recolor-toggle"><input type="checkbox" checked={showRange} onChange={event => setShowRange(event.target.checked)} />{c.showRange}</label></div>
          <div className="canvas-space">
            <div className="editor-stage recolor-stage checkerboard" style={{ "--ratio": source ? source.width / source.height : 1 } as React.CSSProperties}>
              {source ? <canvas ref={stage} width={source.width} height={source.height} role="img" aria-label={c.canvas} /> : null}
              {source ? <canvas ref={overlay} className="recolor-overlay" width={view.width} height={view.height} aria-label={c.paintLabel} style={{ opacity: showRange ? 0.5 : 0 }}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={hideCursor} /> : null}
              <div ref={cursor} className="recolor-cursor" aria-hidden="true" />
              {!app.ready ? <div className="stage-loading"><LoaderCircle size={22} className="spinner" /><span>{c.loading}</span></div> : null}
              {app.ready && !source ? <div className="stage-loading"><ImagePlus size={22} /><span>{c.hintNoImage}</span></div> : null}
              {app.ready && source && app.strokes.length === 0 ? <div className="recolor-hint" aria-hidden="true">{c.hintEmpty}</div> : null}
            </div>
          </div>
          <div className="canvas-caption"><span>{c.exportHint}</span><span className="recolor-status" role="status">{app.busy ? <LoaderCircle size={13} className="spinner" /> : null}{status}</span></div>
        </section>

        <aside className="side-panel inspector-panel" aria-label={c.colorsTitle}>
          <div className="panel-section">
            <div className="section-title"><h2>{c.colorsTitle}</h2><small className="recolor-count">{app.colors.length}/{MAX_COLORS}</small></div>
            {app.colors.length === 0 ? <p className="control-help">{c.noColors}</p> : <ul className="recolor-variants">
              {app.colors.map((hex, index) => {
                const variant = app.variants.find(item => item.color === hex), isSelected = index === app.selected;
                return <li key={hex} className={`recolor-variant ${isSelected ? "is-selected" : ""}`}>
                  <button type="button" className="recolor-variant-main" aria-pressed={isSelected} aria-label={hex} onClick={() => app.select(index)}>
                    <span className="recolor-thumb checkerboard" style={{ background: variant ? undefined : hex }}>{variant ? <Thumb data={variant.thumb} /> : null}</span>
                    <span className="recolor-variant-meta"><i className="recolor-dot" style={{ background: hex }} /><code>{hex}</code>
                      {hasRange && isWideShift(prepared!.sourceL!, hex) ? <TriangleAlert size={12} className="poster-warn-icon" aria-label={c.wide} /> : null}</span></button>
                  <span className="recolor-variant-actions">
                    <button type="button" className="icon-button" aria-label={`${c.download} ${hex}`} title={c.download} disabled={!canExport} onClick={() => void download(index)}>
                      {exporting === index ? <LoaderCircle size={13} className="spinner" /> : <Download size={13} />}</button>
                    <button type="button" className="icon-button" aria-label={`${c.remove} ${hex}`} title={c.remove} onClick={() => app.removeColor(index)}><X size={13} /></button></span>
                </li>;
              })}</ul>}
            {!hasRange && source ? <p className="control-help">{c.needRange}</p> : null}
            <button type="button" className="sample-button" disabled={!app.canAddColor} title={app.canAddColor ? undefined : c.limit}
              onClick={() => app.addColor(PRESET_COLORS.find(hex => !app.colors.includes(hex)) ?? "#808080")}><Plus size={13} />{c.addColor}</button>
            <div className="recolor-presets" role="group" aria-label={c.presets}>
              {PRESET_COLORS.map(hex => <button type="button" key={hex} className="recolor-preset" style={{ background: hex }} aria-label={hex} title={hex}
                disabled={!app.canAddColor || app.colors.includes(hex)} onClick={() => app.addColor(hex)} />)}</div>
            {color ? <label className="poster-field"><span>{c.editColor}</span><span className="poster-color">
              <input type="color" aria-label={c.editColor} value={color.toLowerCase()} onChange={event => app.changeColor(app.selected, event.target.value)} /><code>{color}</code></span></label> : null}
            {wide ? <p className="poster-warning" role="status"><TriangleAlert size={13} />{c.wide}</p> : null}
          </div>
          <div className="generate-section">
            <button type="button" className="primary-button" disabled={!canExport || !color} onClick={() => void download(app.selected)}>
              {exporting === app.selected ? <LoaderCircle size={17} className="spinner" /> : <Download size={17} />}{exporting === app.selected ? c.exporting : c.exportPng}</button>
            <button type="button" className="secondary-button" disabled={!canExport || !color} onClick={() => void makePoster()}>
              {exporting === "poster" ? <LoaderCircle size={17} className="spinner" /> : null}{c.exportPoster}</button>
            <p className="control-help">{c.privacy}</p>
          </div>
        </aside>
      </div>
    </main>
  </div>;
}
