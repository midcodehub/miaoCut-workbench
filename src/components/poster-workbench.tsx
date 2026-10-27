"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Download, ImagePlus, LoaderCircle, Maximize2, Moon, Plus, RotateCw, Scissors, Sticker, Sun, Trash2, TriangleAlert, X } from "lucide-react";
import { downloadPng } from "@/client/assets";
import { drawPoster, ensureFonts, exportPoster } from "@/client/poster-renderer";
import { usePoster } from "@/client/use-poster";
import {
  FONTS, MAX_STICKERS, MAX_TEXT_LAYERS, MAX_TEXT_LENGTH, isSticker, isText, moveBox, resizeBox,
  type Box, type FitResult, type FontId, type StickerLayer, type TextAlign,
} from "@/domain/poster";
import { boxCenter, widthRange } from "@/domain/sticker";
import { BlobImage } from "./blob-image";

const copy = {
  zh: {
    title: "海报文字", intro: "给商品图加上标题、卖点和价格，还可以叠放透明贴纸。文字是精确渲染的：内容逐字一致，修改文字不会触发 AI 生成，也不收费。",
    bgTitle: "背景", uploadBg: "上传背景图片", replaceBg: "更换图片", solidBg: "纯色背景", useSolid: "改用纯色", color: "颜色",
    bgHint: "海报固定为 1:1、1024 × 1024 像素。图片按“填满”方式居中裁切。图片和草稿只保存在当前浏览器。",
    fromResult: "已把传来的图片设为背景，文字保持不变。", textTitle: "文字", addText: "添加文字", limit: `最多 ${MAX_TEXT_LAYERS} 个文字框`,
    empty: "还没有文字。点击“添加文字”开始。", editTitle: "编辑文字", content: "内容", font: "字体", weight: "粗细", regular: "常规", bold: "粗体",
    align: "对齐", left: "左", center: "中", right: "右", textColor: "文字颜色", count: (n: number) => `${n} / ${MAX_TEXT_LENGTH}`,
    autofit: "字号自动适应文本框：拖动文本框右下角改变大小。价格、日期等数字直接写在文字里，导出时逐字保留。",
    fontNote: "中文使用你设备上的系统字体，同一份工程在不同设备上字形可能不同。",
    overflow: "文字超出文本框，已缩到最小字号。请放大文本框或减少文字。", up: "上移一层", down: "下移一层", remove: "删除",
    layerLabel: (n: number, text: string) => `文字框 ${n}：${text}。拖动移动，方向键微调，按住 Shift 加快，Delete 删除`, resize: "调整文字框大小，使用方向键",
    exportPng: "导出 PNG", exporting: "正在导出", exportFailed: "导出失败，请重试。", exportHint: "1024 × 1024 · PNG · 在你的浏览器里生成",
    canvas: "海报预览", back: "返回场景工作台", dismiss: "关闭提示", emptyText: "（空）", loading: "正在准备海报",
    file_type: "请选择 PNG、JPG 或 WebP 图片。", file_size: "图片超过 10 MB，请换一张较小的图片。", image_size: "图片像素过大，请使用不超过 1600 万像素的图片。",
    image_decode: "图片无法读取，请重新选择。", storage_error: "浏览器暂时无法保存草稿，可以继续编辑并导出。",
    switchDark: "切换深色模式", switchLight: "切换浅色模式", language: "Switch to English", privacy: "图片和草稿只保存在当前浏览器",
    layersTitle: "图层", stickerTitle: "贴纸", addSticker: "添加贴纸", uploadSticker: "上传贴纸", sampleSticker: "用示例贴纸试试", stickerLimit: `最多 ${MAX_STICKERS} 张贴纸`,
    stickerHint: "上传带透明背景的 PNG 或 WebP（10 MB 以内）。没有透明区域的图片会被拒绝，把棋盘格画进图里的“假透明”图也一样。贴纸只保存在当前浏览器。",
    stickerLabel: (n: number, name: string) => `贴纸 ${n}：${name}。拖动移动，方向键微调，按住 Shift 加快，Delete 删除`,
    stickerResize: "调整贴纸大小，使用方向键", stickerRotate: "旋转贴纸，使用左右方向键，按住 Shift 每次转 15°", stickerEdit: "编辑贴纸",
    rotation: "旋转", rotationReset: "还原角度", stickerSize: "大小", stickerAlt: "贴纸",
    sticker_no_alpha: "这张图没有透明背景，不能当贴纸。请上传带透明通道的 PNG 或 WebP（JPEG 不支持透明；把棋盘格画进图里的“假透明”图也不行）。",
    sticker_file_type: "请选择带透明背景的 PNG 或 WebP 图片。", sticker_empty: "这张图几乎没有可见内容，不能当贴纸。", sticker_limit: `贴纸已达上限（${MAX_STICKERS} 张），请先删除一张。`,
  },
  en: {
    title: "Poster text", intro: "Add a headline, selling points and a price to a product image, and layer transparent stickers on top. Text is rendered exactly: the content stays character for character, and editing it never runs AI or costs credits.",
    bgTitle: "Background", uploadBg: "Upload a background image", replaceBg: "Replace image", solidBg: "Solid colour", useSolid: "Use a solid colour", color: "Colour",
    bgHint: "Posters are 1:1, 1024 × 1024 pixels. Images are centre-cropped to fill. Images and drafts stay in this browser.",
    fromResult: "The image you sent is now the background. Your text is unchanged.", textTitle: "Text", addText: "Add text", limit: `Up to ${MAX_TEXT_LAYERS} text boxes`,
    empty: "No text yet. Choose “Add text” to start.", editTitle: "Edit text", content: "Content", font: "Font", weight: "Weight", regular: "Regular", bold: "Bold",
    align: "Align", left: "Left", center: "Centre", right: "Right", textColor: "Text colour", count: (n: number) => `${n} / ${MAX_TEXT_LENGTH}`,
    autofit: "Font size fits the box automatically: drag the bottom-right corner to resize. Write prices and dates directly in the text; they are kept exactly.",
    fontNote: "Chinese uses system fonts on your device, so letterforms can differ between devices.",
    overflow: "The text does not fit its box and is at the smallest size. Enlarge the box or shorten the text.", up: "Move up a layer", down: "Move down a layer", remove: "Delete",
    layerLabel: (n: number, text: string) => `Text box ${n}: ${text}. Drag to move, arrow keys to nudge, hold Shift to go faster, Delete to remove`, resize: "Resize the text box with the arrow keys",
    exportPng: "Export PNG", exporting: "Exporting", exportFailed: "Export failed. Please try again.", exportHint: "1024 × 1024 · PNG · generated in your browser",
    canvas: "Poster preview", back: "Back to scene workspace", dismiss: "Dismiss", emptyText: "(empty)", loading: "Preparing the poster",
    file_type: "Choose a PNG, JPG or WebP image.", file_size: "The image is over 10 MB. Choose a smaller one.", image_size: "The image has too many pixels. Use one under 16 million.",
    image_decode: "The image could not be read. Choose another.", storage_error: "The browser cannot save your draft right now. You can keep editing and export.",
    switchDark: "Switch to dark mode", switchLight: "Switch to light mode", language: "切换为中文", privacy: "Images and drafts stay in this browser",
    layersTitle: "Layers", stickerTitle: "Stickers", addSticker: "Add a sticker", uploadSticker: "Upload a sticker", sampleSticker: "Try the sample sticker", stickerLimit: `Up to ${MAX_STICKERS} stickers`,
    stickerHint: "Upload a PNG or WebP with a transparent background (up to 10 MB). Images without transparency are rejected, including fake transparency with a checkerboard drawn into the picture. Stickers stay in this browser.",
    stickerLabel: (n: number, name: string) => `Sticker ${n}: ${name}. Drag to move, arrow keys to nudge, hold Shift to go faster, Delete to remove`,
    stickerResize: "Resize the sticker with the arrow keys", stickerRotate: "Rotate the sticker with the left and right arrow keys, hold Shift for 15° steps", stickerEdit: "Edit sticker",
    rotation: "Rotation", rotationReset: "Reset angle", stickerSize: "Size", stickerAlt: "Sticker",
    sticker_no_alpha: "This image has no transparent background, so it cannot be a sticker. Upload a PNG or WebP with a transparency channel (JPEG has none; a checkerboard drawn into the picture does not count).",
    sticker_file_type: "Choose a PNG or WebP image with a transparent background.", sticker_empty: "This image has almost no visible content, so it cannot be a sticker.", sticker_limit: `You have reached the sticker limit (${MAX_STICKERS}). Delete one first.`,
  },
};
const FONT_IDS = Object.keys(FONTS) as FontId[];
const ALIGNS: TextAlign[] = ["left", "center", "right"];
const preview = (text: string, empty: string) => (text.split("\n")[0].trim().slice(0, 18) || empty);

/** 一次拖动。move/resize 是文字框，move/scale/rotate 是贴纸；贴纸的缩放和旋转以拖动开始时的状态为基准计算。 */
interface Drag {
  id: string; pointer: number; x: number; y: number; box: Box; mode: "move" | "resize" | "scale" | "rotate";
  center?: [number, number]; width?: number; rotation?: number; distance?: number; angle?: number;
}

export function PosterWorkbench() {
  const app = usePoster();
  const { doc, selected, image, locale } = app, c = copy[locale];
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null), stickerInput = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const [fits, setFits] = useState<Map<string, FitResult>>(new Map());
  const [exporting, setExporting] = useState(false), [exportFailed, setExportFailed] = useState(false);
  const imagePending = doc.background.kind === "image" && !image;
  const stickerImages = useMemo(() => new Map([...app.stickers].map(([id, asset]) => [id, asset.image])), [app.stickers]);
  const texts = doc.layers.filter(isText), stickerLayers = doc.layers.filter(isSticker);

  // 预览：先等字体加载好再画，避免第一帧悄悄用回退字体。导出时在这块画布上重画再导出（见 exportPoster 的说明）。
  useEffect(() => {
    const target = canvas.current, context = target?.getContext("2d");
    if (!target || !context || !app.ready) return;
    let cancelled = false;
    void ensureFonts(doc).then(() => { if (!cancelled) setFits(drawPoster(context, doc, image, stickerImages)); });
    return () => { cancelled = true; };
  }, [doc, image, stickerImages, app.ready]);

  const startDrag = (event: React.PointerEvent<HTMLElement>, id: string, box: Box, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    app.select(id); drag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, box, mode };
  };
  const startStickerDrag = (event: React.PointerEvent<HTMLElement>, layer: StickerLayer, mode: "move" | "scale" | "rotate") => {
    const bounds = stage.current?.getBoundingClientRect();
    if (event.button !== 0 || !bounds) return;
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    app.select(layer.id);
    // 缩放和旋转都绕贴纸中心：记下拖动开始时指针到中心的距离和方向，之后按比例和角度差计算，抓住手柄时不会跳动。
    const [cx, cy] = boxCenter(layer.box), centerX = bounds.left + cx * bounds.width, centerY = bounds.top + cy * bounds.height;
    drag.current = {
      id: layer.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, box: layer.box, mode, center: [cx, cy],
      width: layer.box[2] - layer.box[0], rotation: layer.rotation,
      distance: Math.max(1, Math.hypot(event.clientX - centerX, event.clientY - centerY)), angle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
    };
  };
  const onDrag = (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current, bounds = stage.current?.getBoundingClientRect();
    if (!current || current.pointer !== event.pointerId || !bounds) return;
    const dx = (event.clientX - current.x) / bounds.width, dy = (event.clientY - current.y) / bounds.height;
    if (current.mode === "move" || current.mode === "resize") {
      if (current.center) app.patchSticker(current.id, { cx: current.center[0] + dx, cy: current.center[1] + dy });
      else app.patchLayer(current.id, { box: current.mode === "move" ? moveBox(current.box, dx, dy) : resizeBox(current.box, current.box[2] + dx, current.box[3] + dy) });
      return;
    }
    if (!current.center || current.width === undefined || current.rotation === undefined || current.distance === undefined || current.angle === undefined) return;
    const centerX = bounds.left + current.center[0] * bounds.width, centerY = bounds.top + current.center[1] * bounds.height;
    if (current.mode === "scale") {
      app.patchSticker(current.id, { cx: current.center[0], cy: current.center[1], width: current.width * (Math.hypot(event.clientX - centerX, event.clientY - centerY) / current.distance) });
    } else {
      const turned = current.rotation + ((Math.atan2(event.clientY - centerY, event.clientX - centerX) - current.angle) * 180) / Math.PI;
      app.patchSticker(current.id, { rotation: event.shiftKey ? Math.round(turned / 15) * 15 : turned });
    }
  };
  const endDrag = () => { drag.current = null; };
  // 贴纸移动用 Shift 加快；缩放键：右/上变大、左/下变小；旋转键：左右各转 1°，Shift 转 15°。
  const onStickerKeys = (event: React.KeyboardEvent<HTMLElement>, layer: StickerLayer, mode: "move" | "scale" | "rotate") => {
    if (mode === "move" && event.key === "Delete") { event.preventDefault(); app.deleteLayer(layer.id); return; }
    const [cx, cy] = boxCenter(layer.box), width = layer.box[2] - layer.box[0], coarse = event.shiftKey;
    const left = event.key === "ArrowLeft", right = event.key === "ArrowRight", up = event.key === "ArrowUp", down = event.key === "ArrowDown";
    if (!left && !right && !up && !down) return;
    event.preventDefault(); event.stopPropagation();
    if (mode === "move") { const step = coarse ? 0.04 : 0.01; app.patchSticker(layer.id, { cx: cx + (left ? -step : right ? step : 0), cy: cy + (up ? -step : down ? step : 0) }); }
    else if (mode === "scale") app.patchSticker(layer.id, { cx, cy, width: width * (1 + (right || up ? 1 : -1) * (coarse ? 0.1 : 0.02)) });
    else if (left || right) app.patchSticker(layer.id, { rotation: layer.rotation + (right ? 1 : -1) * (coarse ? 15 : 1) });
  };
  const onKeys = (event: React.KeyboardEvent<HTMLElement>, id: string, box: Box, mode: "move" | "resize") => {
    if (mode === "move" && event.key === "Delete") { event.preventDefault(); app.deleteLayer(id); return; }
    const step = event.shiftKey ? 0.04 : 0.01;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    app.patchLayer(id, { box: mode === "move" ? moveBox(box, dx, dy) : resizeBox(box, box[2] + dx, box[3] + dy) });
  };
  const exportImage = async () => {
    const target = canvas.current;
    if (exporting || !app.ready || imagePending || !target) return;
    setExporting(true); setExportFailed(false);
    try { downloadPng(await exportPoster(doc, image, target, stickerImages), `miaocut-poster-${doc.revision}.png`); }
    catch { setExportFailed(true); }
    finally { setExporting(false); }
  };

  const bg = doc.background, selectedFit = selected && isText(selected) ? fits.get(selected.id) : undefined;
  const addStickerButtonTitle = app.canAddSticker ? undefined : c.stickerLimit;
  return <div className="workbench-app poster-app">
    <header className="site-header"><div className="header-content">
      <a href="https://miaocut.app" className="brand-link" aria-label="MiaoCut"><span className="brand-mark"><Scissors size={19} strokeWidth={1.7} /></span>MiaoCut</a>
      <span className="header-divider" /><span className="header-workspace">{c.title}</span>
      <div className="header-actions"><a className="header-link" href="/workbench/recolor">{locale === "zh" ? "精确换色" : "Recolour"}</a><a className="header-link" href="/workbench/product"><ArrowLeft size={13} />{c.back}</a>
        <button type="button" className="icon-button language-button" aria-label={c.language} onClick={() => app.setLocale(locale === "zh" ? "en" : "zh")}>{locale === "zh" ? "EN" : "中"}</button>
        <button type="button" className="icon-button" aria-label={app.dark ? c.switchLight : c.switchDark} onClick={app.toggleTheme}>{app.dark ? <Sun size={18} /> : <Moon size={18} />}</button>
      </div>
    </div></header>
    <main className="workspace-main">
      <div className="page-heading"><div><h1>{c.title}</h1><p>{c.intro}</p></div></div>
      {app.notice ? <div className="error-notice" role="alert"><span>{c[app.notice]}</span>
        <button type="button" className="icon-button" aria-label={c.dismiss} onClick={app.dismissNotice}><X size={16} /></button></div> : null}
      {app.fromResult ? <div className="demo-notice" role="status"><span>{c.fromResult}</span>
        <button type="button" onClick={app.dismissFromResult}>{c.dismiss}</button></div> : null}

      <div className="workspace-grid">
        <aside className="side-panel" aria-label={c.bgTitle}><div className="panel-section">
          <div className="section-title"><h2>{c.bgTitle}</h2><ImagePlus size={16} /></div>
          <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={c.uploadBg}
            onChange={event => { const file = event.target.files?.[0]; if (file) void app.uploadBackground(file); event.currentTarget.value = ""; }} />
          <button type="button" className="upload-zone" disabled={!app.ready} onClick={() => fileInput.current?.click()}>
            {bg.kind === "image" && app.background ? <span className="asset-thumbnail checkerboard"><BlobImage blob={app.background} alt="" /></span> : <ImagePlus size={24} />}
            <span className="upload-zone-label">{bg.kind === "image" ? c.replaceBg : c.uploadBg}</span></button>
          <label className="poster-field"><span>{c.solidBg}</span>
            <span className="poster-color"><input type="color" aria-label={c.color} value={bg.kind === "solid" ? bg.color : "#FFFFFF"} disabled={!app.ready}
              onChange={event => app.setColor(event.target.value)} /><code>{bg.kind === "solid" ? bg.color.toUpperCase() : "—"}</code></span></label>
          {bg.kind === "image" ? <button type="button" className="sample-button" onClick={() => app.setColor("#FFFFFF")}>{c.useSolid}</button> : null}
          <p className="control-help">{c.bgHint}</p>
        </div>
        <div className="panel-section">
          <div className="section-title"><h2>{c.stickerTitle}</h2><Sticker size={16} /></div>
          <input ref={stickerInput} type="file" hidden accept="image/png,image/webp" aria-label={c.uploadSticker}
            onChange={event => { const file = event.target.files?.[0]; if (file) void app.addStickerFile(file); event.currentTarget.value = ""; }} />
          <button type="button" className="sample-button poster-sticker-add" disabled={!app.ready || !app.canAddSticker} title={addStickerButtonTitle} onClick={() => stickerInput.current?.click()}>
            <Plus size={13} />{c.uploadSticker} · {stickerLayers.length}/{MAX_STICKERS}</button>
          <button type="button" className="sample-button" disabled={!app.ready || !app.canAddSticker} title={addStickerButtonTitle} onClick={() => void app.addSampleSticker()}>{c.sampleSticker}</button>
          <p className="control-help">{c.stickerHint}</p>
        </div></aside>

        <section className="canvas-panel" aria-label={c.canvas}>
          <div className="canvas-toolbar"><span>{c.canvas}</span>
            <span className="poster-toolbar-actions">
              <button type="button" className="subtle-button" disabled={!app.canAddSticker || !app.ready} onClick={() => stickerInput.current?.click()} title={addStickerButtonTitle}>
                <Sticker size={14} />{c.addSticker} · {stickerLayers.length}/{MAX_STICKERS}</button>
              <button type="button" className="subtle-button" disabled={!app.canAdd || !app.ready} onClick={app.addLayer} title={app.canAdd ? undefined : c.limit}>
                <Plus size={14} />{c.addText} · {texts.length}/{MAX_TEXT_LAYERS}</button></span></div>
          <div className="canvas-space">
            <div ref={stage} className="editor-stage poster-stage" onPointerDown={event => { if (event.target === event.currentTarget) app.select(null); }}>
              <canvas ref={canvas} width={1024} height={1024} role="img" aria-label={c.canvas} />
              {!app.ready || imagePending ? <div className="stage-loading"><LoaderCircle size={22} className="spinner" /><span>{c.loading}</span></div> : null}
              {app.ready ? doc.layers.map(layer => {
                const isSelected = layer.id === app.selectedId, box = layer.box;
                const placement = { left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` };
                if (isSticker(layer)) {
                  return <div key={layer.id} role="group" tabIndex={0} aria-label={c.stickerLabel(stickerLayers.indexOf(layer) + 1, layer.name)}
                    className={`poster-box poster-sticker ${isSelected ? "is-selected" : ""}`} style={{ ...placement, transform: `rotate(${layer.rotation}deg)` }}
                    onFocus={() => app.select(layer.id)} onPointerDown={event => startStickerDrag(event, layer, "move")} onPointerMove={onDrag}
                    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={event => onStickerKeys(event, layer, "move")}>
                    {isSelected ? <>
                      <button type="button" className="resize-handle" aria-label={c.stickerResize} title={c.stickerResize}
                        onPointerDown={event => startStickerDrag(event, layer, "scale")} onPointerMove={onDrag} onPointerUp={endDrag}
                        onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={event => onStickerKeys(event, layer, "scale")}><Maximize2 size={12} /></button>
                      <button type="button" className="rotate-handle" aria-label={c.stickerRotate} title={c.stickerRotate}
                        onPointerDown={event => startStickerDrag(event, layer, "rotate")} onPointerMove={onDrag} onPointerUp={endDrag}
                        onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={event => onStickerKeys(event, layer, "rotate")}><RotateCw size={12} /></button>
                    </> : null}
                  </div>;
                }
                const overflow = fits.get(layer.id)?.overflow;
                return <div key={layer.id} role="group" tabIndex={0} aria-label={c.layerLabel(texts.indexOf(layer) + 1, preview(layer.text, c.emptyText))}
                  className={`poster-box ${isSelected ? "is-selected" : ""} ${overflow ? "is-overflow" : ""}`} style={placement}
                  onFocus={() => app.select(layer.id)} onPointerDown={event => startDrag(event, layer.id, layer.box, "move")} onPointerMove={onDrag}
                  onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={event => onKeys(event, layer.id, layer.box, "move")}>
                  {isSelected ? <button type="button" className="resize-handle" aria-label={c.resize} title={c.resize}
                    onPointerDown={event => startDrag(event, layer.id, layer.box, "resize")} onPointerMove={onDrag} onPointerUp={endDrag}
                    onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={event => onKeys(event, layer.id, layer.box, "resize")}><Maximize2 size={12} /></button> : null}
                </div>;
              }) : null}
            </div>
          </div>
          <div className="canvas-caption"><span>{c.exportHint}</span></div>
        </section>

        <aside className="side-panel inspector-panel" aria-label={c.layersTitle}>
          <div className="panel-section"><div className="section-title"><h2>{c.layersTitle}</h2></div>
            {doc.layers.length === 0 ? <p className="control-help">{c.empty}</p> : <ul className="poster-layers">
              {[...doc.layers].reverse().map(layer => {
                const index = doc.layers.indexOf(layer), isSelected = layer.id === app.selectedId, asset = app.stickers.get(layer.id);
                return <li key={layer.id} className={`poster-layer ${isSelected ? "is-selected" : ""}`}>
                  <button type="button" className="poster-layer-main" aria-pressed={isSelected} onClick={() => app.select(layer.id)}>
                    {isSticker(layer)
                      ? <><span className="poster-layer-thumb checkerboard">{asset ? <BlobImage blob={asset.blob} alt="" /> : null}</span><span className="poster-layer-text">{layer.name}</span></>
                      : <>{fits.get(layer.id)?.overflow ? <TriangleAlert size={12} className="poster-warn-icon" aria-label={c.overflow} /> : null}<span className="poster-layer-text">{preview(layer.text, c.emptyText)}</span></>}</button>
                  <button type="button" className="icon-button" aria-label={c.up} title={c.up} disabled={index === doc.layers.length - 1} onClick={() => app.reorder(layer.id, "up")}><ArrowUp size={13} /></button>
                  <button type="button" className="icon-button" aria-label={c.down} title={c.down} disabled={index === 0} onClick={() => app.reorder(layer.id, "down")}><ArrowDown size={13} /></button>
                  <button type="button" className="icon-button" aria-label={c.remove} title={c.remove} onClick={() => app.deleteLayer(layer.id)}><Trash2 size={13} /></button>
                </li>;
              })}</ul>}
          </div>
          {selected && isText(selected) ? <div className="panel-section poster-editor">
            <div className="section-title"><h2>{c.editTitle}</h2></div>
            <label className="poster-field"><span>{c.content}<small>{c.count(selected.text.length)}</small></span>
              <textarea className="poster-textarea" value={selected.text} maxLength={MAX_TEXT_LENGTH} rows={4}
                onChange={event => app.patchLayer(selected.id, { text: event.target.value })} /></label>
            {selectedFit?.overflow ? <p className="poster-warning" role="status"><TriangleAlert size={13} />{c.overflow}</p> : null}
            <label className="poster-field"><span>{c.font}</span>
              <select className="poster-select" value={selected.fontId} onChange={event => app.patchLayer(selected.id, { fontId: event.target.value as FontId })}>
                {FONT_IDS.map(id => <option key={id} value={id}>{FONTS[id].label[locale]}</option>)}</select></label>
            <div className="poster-field"><span>{c.weight}</span><div className="poster-segment" role="group" aria-label={c.weight}>
              <button type="button" aria-pressed={selected.weight === 400} onClick={() => app.patchLayer(selected.id, { weight: 400 })}>{c.regular}</button>
              <button type="button" aria-pressed={selected.weight === 700} onClick={() => app.patchLayer(selected.id, { weight: 700 })}>{c.bold}</button></div></div>
            <div className="poster-field"><span>{c.align}</span><div className="poster-segment" role="group" aria-label={c.align}>
              {ALIGNS.map(align => <button type="button" key={align} aria-pressed={selected.align === align} onClick={() => app.patchLayer(selected.id, { align })}>{c[align]}</button>)}</div></div>
            <label className="poster-field"><span>{c.textColor}</span><span className="poster-color">
              <input type="color" value={selected.color} onChange={event => app.patchLayer(selected.id, { color: event.target.value })} /><code>{selected.color}</code></span></label>
            <p className="control-help">{c.autofit}</p><p className="control-help">{c.fontNote}</p>
          </div> : null}
          {selected && isSticker(selected) ? <StickerEditor layer={selected} c={c} onPatch={patch => app.patchSticker(selected.id, patch)} /> : null}
          <div className="generate-section">
            <button type="button" className="primary-button" disabled={!app.ready || exporting || imagePending} onClick={() => void exportImage()}>
              {exporting ? <LoaderCircle size={17} className="spinner" /> : <Download size={17} />}{exporting ? c.exporting : c.exportPng}</button>
            {exportFailed ? <p className="poster-warning" role="alert"><TriangleAlert size={13} />{c.exportFailed}</p> : null}
            <p className="control-help">{c.privacy}</p>
          </div>
        </aside>
      </div>
    </main>
  </div>;
}

/** 贴纸的属性：旋转角度和大小（占画布宽度的百分比）。位置和缩放也可以直接在画布上拖。 */
function StickerEditor({ layer, c, onPatch }: { layer: StickerLayer; c: (typeof copy)["zh"] | (typeof copy)["en"]; onPatch: (patch: { width?: number; rotation?: number }) => void }) {
  const width = layer.box[2] - layer.box[0], [low, high] = widthRange(layer.width / layer.height);
  return <div className="panel-section poster-editor">
    <div className="section-title"><h2>{c.stickerEdit}</h2></div>
    <p className="control-help poster-sticker-name">{layer.name} · {layer.width}×{layer.height}</p>
    <label className="poster-field"><span>{c.rotation}<small>{layer.rotation}°</small></span>
      <input type="range" className="poster-slider" min={-180} max={180} step={1} value={Math.round(layer.rotation)} onChange={event => onPatch({ rotation: Number(event.target.value) })} /></label>
    <button type="button" className="sample-button" disabled={layer.rotation === 0} onClick={() => onPatch({ rotation: 0 })}>{c.rotationReset}</button>
    <label className="poster-field"><span>{c.stickerSize}<small>{Math.round(width * 100)}%</small></span>
      <input type="range" className="poster-slider" min={Math.ceil(low * 100)} max={Math.floor(high * 100)} step={1} value={Math.round(width * 100)} onChange={event => onPatch({ width: Number(event.target.value) / 100 })} /></label>
  </div>;
}
