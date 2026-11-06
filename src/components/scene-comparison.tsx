'use client';

import {useEffect, useId, useState} from 'react';
import {Download, RefreshCw} from 'lucide-react';
import type {LocalAsset, Locale, ProductDocument} from '@/domain/contracts';
import {compositionKey, type FreeBackground} from '@/domain/comparison';
import {renderFreeComposition} from '@/client/free-composition';
import {downloadPng} from '@/client/assets';
import {BlobImage} from './blob-image';

/**
 * foreground / ai 是页面上显示用的图，可能是服务端的缩小预览（foreground.preview === true / aiIsPreview）。
 * 两个下载按钮必须给用户原始分辨率：loadOriginal 负责取回原图——AI 图直接下载原 PNG；
 * 免费合成是在浏览器里用抠图画出来的，显示用的是预览画的那一张，下载时用完整分辨率的抠图重新合成一次。
 */
export function SceneComparison({document:doc,foreground,ai,aiIsPreview=false,loadOriginal,locale='zh'}:{
  document:ProductDocument;foreground?:LocalAsset;ai?:Blob;aiIsPreview?:boolean;locale?:Locale;
  loadOriginal?:{foreground:()=>Promise<LocalAsset>;ai:()=>Promise<Blob>};
}) {
  const zh=locale==='zh',id=useId(),key=compositionKey(doc);
  const [background,setBackground]=useState<FreeBackground>('scene'),[wipe,setWipe]=useState(false),[position,setPosition]=useState(50),[attempt,setAttempt]=useState(0);
  const [rendered,setRendered]=useState<{key:string;background:FreeBackground;source:Blob;blob:Blob}>();
  const [failure,setFailure]=useState<{key:string;background:FreeBackground;source:Blob}>();
  useEffect(()=>{
    if(!foreground)return;
    const controller=new AbortController(),source=foreground.blob;
    const timer=setTimeout(()=>{void renderFreeComposition(doc,foreground,background,controller.signal).then(blob=>{
      if(!controller.signal.aborted)setRendered({key,background,source,blob});
    }).catch(()=>{if(!controller.signal.aborted)setFailure({key,background,source});});},200);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[doc,foreground,background,key,attempt]);
  const local=rendered?.key===key&&rendered.background===background&&rendered.source===foreground?.blob?rendered.blob:undefined;
  const failed=!local&&failure?.key===key&&failure.background===background&&failure.source===foreground?.blob;
  const [saving,setSaving]=useState<'free'|'ai'|null>(null),[saveFailed,setSaveFailed]=useState(false);
  const saveFree=async()=>{
    if(!local||saving)return;
    setSaving('free');setSaveFailed(false);
    try{
      let blob=local;
      if(foreground?.preview){
        if(!loadOriginal)throw new Error('original_unavailable');
        blob=await renderFreeComposition(doc,await loadOriginal.foreground(),background,new AbortController().signal);
      }
      downloadPng(blob,`miaocut-free-${doc.scene}.png`);
    }catch{setSaveFailed(true);}finally{setSaving(null);}
  };
  const saveAi=async()=>{
    if(!ai||saving)return;
    setSaving('ai');setSaveFailed(false);
    try{
      if(aiIsPreview&&!loadOriginal)throw new Error('original_unavailable');
      downloadPng(aiIsPreview&&loadOriginal?await loadOriginal.ai():ai,`miaocut-ai-${doc.scene}.png`);
    }catch{setSaveFailed(true);}finally{setSaving(null);}
  };
  const freeLabel=zh?'免费合成':'Free composition',aiLabel=zh?'AI 场景':'AI scene';
  const empty=failed?(zh?'免费合成未完成，请重试。':'Composition failed. Try again.'):
    foreground?(zh?'正在本地合成…':'Composing locally…'):(zh?'提取主体后可查看免费合成。':'Extract a subject to see the free composition.');
  return <section className="comparison-panel" aria-labelledby={`${id}-title`}>
    <div className="comparison-heading"><div><h2 id={`${id}-title`}>{zh?'同一商品，看看两种效果':'Same product, two approaches'}</h2>
      <p>{zh?'免费版使用固定背景与规则阴影；AI 版生成新的背景和阴影。':'The free version uses a preset backdrop and rule-based shadows. AI generates the background and shadows.'}</p></div>
      <div className="comparison-view" role="group" aria-label={zh?'对比方式':'Comparison view'}>
        <button type="button" aria-pressed={!wipe} onClick={()=>setWipe(false)}>{zh?'并排':'Side by side'}</button>
        <button type="button" aria-pressed={wipe} disabled={!local||!ai} onClick={()=>setWipe(true)}>{zh?'滑动对比':'Wipe'}</button>
      </div>
    </div>
    <div className="comparison-presets" role="group" aria-label={zh?'免费版背景':'Free background'}><span>{zh?'免费版背景':'Free backdrop'}</span>
      {(['scene','white','studio'] as const).map(value=><button key={value} type="button" aria-pressed={background===value} onClick={()=>setBackground(value)}>{
        value==='scene'?(zh?'同场景模板':'Scene preset'):value==='white'?(zh?'纯白':'White'):(zh?'柔光灰':'Studio grey')}</button>)}
    </div>
    {wipe&&local&&ai?<div className="comparison-wipe">
      <div className="comparison-wipe-images"><BlobImage blob={ai} alt={aiLabel} width={1024} height={1024}/>
        <div className="comparison-wipe-cover" style={{clipPath:`inset(0 ${100-position}% 0 0)`}}><BlobImage blob={local} alt={freeLabel} width={1024} height={1024}/></div>
        <div className="comparison-divider" style={{left:`${position}%`}} aria-hidden="true"/>
      </div><div className="comparison-range"><span>{freeLabel}</span><label className="sr-only" htmlFor={`${id}-wipe`}>{zh?'免费合成显示比例':'Free composition reveal'}</label>
        <input id={`${id}-wipe`} type="range" min={0} max={100} value={position} onChange={event=>setPosition(Number(event.target.value))}/><span>{aiLabel}</span></div>
    </div>:<div className="comparison-pair">
      <figure><figcaption><strong>{freeLabel}</strong><span>{zh?'本地处理 · 无需等待生成':'Local · No generation queue'}</span></figcaption>
        <div className="comparison-image">{local?<BlobImage blob={local} alt={freeLabel} width={1024} height={1024}/>:<div className="comparison-empty" role="status"><p>{empty}</p>{failed?<button type="button" className="subtle-button" onClick={()=>setAttempt(n=>n+1)}><RefreshCw size={14}/>{zh?'重试合成':'Retry'}</button>:null}</div>}</div></figure>
      <figure><figcaption><strong>{aiLabel}</strong><span>{ai?(zh?'已完成的生成结果':'Completed generation'):(zh?'生成完成后在这里对比':'Compare after generation')}</span></figcaption>
        <div className="comparison-image">{ai?<BlobImage blob={ai} alt={aiLabel} width={1024} height={1024}/>:<div className="comparison-empty"><p>{zh?'AI 结果尚未生成。免费合成可以先使用。':'No AI result yet. You can use the free composition now.'}</p></div>}</div></figure>
    </div>}
    <div className="comparison-downloads">
      <button type="button" className="secondary-button" disabled={!local||saving!==null} aria-busy={saving==='free'} onClick={()=>void saveFree()}><Download size={15}/>{saving==='free'?(zh?'正在取回原图…':'Fetching original…'):(zh?'下载免费合成':'Download free composition')}</button>
      <button type="button" className="secondary-button" disabled={!ai||saving!==null} aria-busy={saving==='ai'} onClick={()=>void saveAi()}><Download size={15}/>{saving==='ai'?(zh?'正在取回原图…':'Fetching original…'):(zh?'下载 AI 场景':'Download AI scene')}</button>
    </div>
    {saveFailed?<p className="control-help" role="alert">{zh?'下载失败，请重试。':'Download failed. Try again.'}</p>:null}
    <p className="comparison-footnote">{zh?'对比使用同一前景和记录的构图。浏览器与服务端的缩放采样可能有细微差别；免费合成不重新运行抠图或生成模型。':'Both use the same foreground and recorded layout. Browser and server resizing may differ slightly. The free composition does not rerun segmentation or generation.'}</p>
  </section>;
}
