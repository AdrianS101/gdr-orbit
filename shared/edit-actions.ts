// Vocabulário de edição: cada ação vira uma alteração revisável e desfazível na timeline.
// Usado pelo chat com IA (a IA só escolhe ações desta lista) e pelas ações rápidas (sem IA).
import type { Asset, CaptionWord, DenoiseLevel, FormatPreset, TextAnim, TextClip, TextStyleKind, Timeline, TransitionType } from './types.ts';
import { clamp, defaultCaptionY, layoutClips, makeFormat, rippleDelete, splitAt, timelineDuration, uid } from './timeline.ts';
import { buildCues } from './captions.ts';
import { colorFromPreset, COLOR_PRESETS, removePauses } from './effects.ts';
import { DENOISE_LABEL, newLayer } from './keyframes.ts';

export type EditAction =
  | { type: 'remove_pauses'; minGap?: number }
  | { type: 'cut'; start: number; end: number }
  | { type: 'keep_only'; start: number; end: number }
  | { type: 'captions'; preset?: 'highlight' | 'pop' | 'karaoke' | 'classic' | 'box'; highlightColor?: string; uppercase?: boolean; position?: 'top' | 'middle' | 'bottom' }
  | { type: 'logo'; position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' }
  | { type: 'text'; text: string; start: number; duration?: number; kind?: TextStyleKind; anim?: TextAnim }
  | { type: 'transitions'; transition: TransitionType; duration?: number }
  | { type: 'filter'; preset: string }
  | { type: 'zoom'; start: number; end: number; scale?: number }
  | { type: 'dynamic_zoom' }
  | { type: 'speed'; start: number; end: number; speed: number }
  | { type: 'music'; assetId: string; volume?: number; ducking?: boolean }
  | { type: 'format'; preset: Exclude<FormatPreset, 'custom'> }
  | { type: 'denoise'; level?: DenoiseLevel }
  | { type: 'pip'; assetId: string; start: number; duration?: number; position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center'; anim?: 'fade' | 'pop' | 'slide' | 'none' }
  | { type: 'broll'; assetId: string; start: number; duration?: number };

export interface ActionContext {
  transcripts: Record<string, CaptionWord[]>;
  assets: Record<string, Asset>;
  brand: { colors: string[]; logoAssetId: string | null; font?: string };
}

export interface ActionResult {
  timeline: Timeline;
  label: string;
}

/** Descrição curta em português (exibida antes de aplicar). */
export function describeAction(a: EditAction, ctx?: ActionContext): string {
  const t = (n: number) => `${n.toFixed(1).replace('.', ',')}s`;
  switch (a.type) {
    case 'remove_pauses': return 'Remover pausas e silêncios (sem cortar falas)';
    case 'cut': return `Cortar de ${t(a.start)} a ${t(a.end)}`;
    case 'keep_only': return `Manter só de ${t(a.start)} a ${t(a.end)}`;
    case 'captions': return `Legendas animadas${a.preset ? ` (${a.preset})` : ''}${a.highlightColor ? ` com destaque ${a.highlightColor}` : ''}`;
    case 'logo': return `Aplicar logo (${a.position ?? 'top-right'})`;
    case 'text': return `${a.kind === 'cta' ? 'Chamada' : a.kind === 'lower' ? 'Lower third' : 'Título'} "${a.text}" em ${t(a.start)}`;
    case 'transitions': return `Transição "${a.transition}" em todos os cortes`;
    case 'filter': return `Filtro ${COLOR_PRESETS[a.preset]?.label ?? a.preset}`;
    case 'zoom': return `Zoom ${a.scale ?? 1.15}× de ${t(a.start)} a ${t(a.end)}`;
    case 'dynamic_zoom': return 'Zoom dinâmico alternado nos trechos';
    case 'speed': return `Velocidade ${a.speed}× de ${t(a.start)} a ${t(a.end)}`;
    case 'music': return `Música "${ctx?.assets[a.assetId]?.name ?? a.assetId}" com volume reduzido na fala`;
    case 'format': return `Formato ${a.preset}`;
    case 'denoise': return `Reduzir ruído do áudio (${DENOISE_LABEL[a.level ?? 'light'].split(' (')[0].toLowerCase()})`;
    case 'pip': return `Sobrepor "${ctx?.assets[a.assetId]?.name ?? a.assetId}" em janela em ${t(a.start)}`;
    case 'broll': return `B-roll "${ctx?.assets[a.assetId]?.name ?? a.assetId}" em ${t(a.start)}`;
  }
}

/** Isola o intervalo [a,b) em trechos próprios e devolve os ids deles. */
function isolate(tl: Timeline, a: number, b: number): { tl: Timeline; ids: string[] } {
  let cur = splitAt(tl, b).timeline;
  cur = splitAt(cur, a).timeline;
  const ids = layoutClips(cur.clips).filter((p) => p.start >= a - 1e-3 && p.end <= b + 1e-3).map((p) => p.clip.id);
  return { tl: cur, ids };
}

export function applyAction(tl: Timeline, a: EditAction, ctx: ActionContext): ActionResult {
  const total = timelineDuration(tl);
  const label = describeAction(a, ctx);
  const rng = (s: number, e: number) => {
    const S = clamp(Number(s) || 0, 0, total);
    const E = clamp(Number(e) || 0, 0, total);
    if (E - S < 0.05) throw new Error(`Intervalo inválido (${S.toFixed(1)}–${E.toFixed(1)}s).`);
    return [S, E] as const;
  };
  switch (a.type) {
    case 'remove_pauses': {
      const r = removePauses(tl, ctx.transcripts, a.minGap ?? 0.6);
      if (!r.removed) throw new Error('Nenhuma pausa encontrada. O vídeo precisa estar transcrito.');
      return { timeline: r.timeline, label: `Remover ${r.removed} pausas (${r.seconds.toFixed(1)}s)` };
    }
    case 'cut': {
      const [s, e] = rng(a.start, a.end);
      return { timeline: rippleDelete(tl, s, e), label };
    }
    case 'keep_only': {
      const [s, e] = rng(a.start, a.end);
      let cur = e < total ? rippleDelete(tl, e, total) : tl;
      if (s > 0) cur = rippleDelete(cur, 0, s);
      return { timeline: cur, label };
    }
    case 'captions': {
      const style = { ...tl.captions.style };
      if (a.preset) style.preset = a.preset;
      if (a.highlightColor && /^#[0-9a-f]{6}$/i.test(a.highlightColor)) style.highlightColor = a.highlightColor.toUpperCase();
      else if (!a.highlightColor && ctx.brand.colors[0]) style.highlightColor = ctx.brand.colors[0];
      if (a.uppercase !== undefined) style.uppercase = a.uppercase;
      if (a.position) style.posY = a.position === 'top' ? 0.2 : a.position === 'middle' ? 0.5 : defaultCaptionY(tl.format);
      let cues = tl.captions.cues;
      if (!cues.length) {
        const used = Array.from(new Set(tl.clips.map((c) => c.assetId)));
        cues = used.flatMap((id) => (ctx.transcripts[id] ? buildCues(id, ctx.transcripts[id], style, tl.clips.filter((c) => c.assetId === id).map((c) => ({ from: c.in, to: c.out }))) : []));
        if (!cues.length) throw new Error('Não há transcrição para gerar legendas. Transcreva o vídeo na aba Legendas.');
      }
      return { timeline: { ...tl, captions: { enabled: true, style, cues } }, label };
    }
    case 'logo': {
      const logo = ctx.brand.logoAssetId ? ctx.assets[ctx.brand.logoAssetId] : null;
      if (!logo?.meta.width) throw new Error('A marca não tem logo definido. Defina em Marcas → Identidade visual.');
      const vertical = tl.format.height > tl.format.width;
      const width = vertical ? 0.2 : 0.11;
      const hFrac = (width * tl.format.width * ((logo.meta.height ?? 1) / (logo.meta.width ?? 1))) / tl.format.height;
      const pos = a.position ?? 'top-right';
      const mx = vertical ? 0.06 : 0.03;
      const top = vertical ? 0.13 : 0.05;
      const bottom = vertical ? 0.78 : 0.95;
      const x = pos.endsWith('right') ? 1 - width / 2 - mx : width / 2 + mx;
      const y = pos.startsWith('top') ? top + hFrac / 2 : bottom - hFrac / 2;
      const overlays = tl.overlays.filter((o) => o.assetId !== logo.id);
      overlays.push({ id: uid('o_'), assetId: logo.id, start: 0, end: total, x, y, width, opacity: 1 });
      return { timeline: { ...tl, overlays }, label };
    }
    case 'text': {
      const kind = a.kind ?? 'title';
      const start = clamp(Number(a.start) || 0, 0, Math.max(0, total - 0.3));
      const t: TextClip = {
        id: uid('t_'),
        start,
        end: Math.min(total, start + (a.duration ?? 3)),
        text: String(a.text ?? '').slice(0, 120),
        kind,
        anim: a.anim ?? (kind === 'lower' ? 'slide' : 'pop'),
        ...textDefaults(kind, tl, ctx),
      };
      if (!t.text.trim()) throw new Error('Texto vazio.');
      return { timeline: { ...tl, texts: [...(tl.texts ?? []), t] }, label };
    }
    case 'transitions': {
      if (tl.clips.length < 2) throw new Error('Só há um trecho: não existem cortes para receber transição.');
      const duration = clamp(a.duration ?? 0.5, 0.2, 2);
      return { timeline: { ...tl, clips: tl.clips.map((c, i) => (i === 0 ? c : { ...c, transition: { type: a.transition, duration } })) }, label };
    }
    case 'filter': {
      if (!COLOR_PRESETS[a.preset]) throw new Error(`Filtro desconhecido: ${a.preset}.`);
      return { timeline: { ...tl, clips: tl.clips.map((c) => ({ ...c, color: colorFromPreset(a.preset) })) }, label };
    }
    case 'zoom': {
      const [s, e] = rng(a.start, a.end);
      const z = clamp(a.scale ?? 1.15, 1, 2);
      const r = isolate(tl, s, e);
      return { timeline: { ...r.tl, clips: r.tl.clips.map((c) => (r.ids.includes(c.id) ? { ...c, zoom: { from: z, to: z } } : c)) }, label };
    }
    case 'dynamic_zoom': {
      return { timeline: { ...tl, clips: tl.clips.map((c, i) => ({ ...c, zoom: i % 2 === 0 ? { from: 1, to: 1.12 } : { from: 1.12, to: 1 } })) }, label };
    }
    case 'speed': {
      const [s, e] = rng(a.start, a.end);
      const sp = clamp(Number(a.speed) || 1, 0.25, 4);
      const r = isolate(tl, s, e);
      return { timeline: { ...r.tl, clips: r.tl.clips.map((c) => (r.ids.includes(c.id) ? { ...c, speed: sp } : c)) }, label };
    }
    case 'music': {
      const m = ctx.assets[a.assetId];
      if (!m || m.kind !== 'audio') throw new Error('Música não encontrada na biblioteca da marca.');
      return { timeline: { ...tl, music: { assetId: m.id, volume: clamp(a.volume ?? 0.35, 0, 1), ducking: a.ducking ?? true, duckLevel: 0.25, fadeIn: 0.5, fadeOut: 1.5, offset: 0 } }, label };
    }
    case 'format': {
      const format = makeFormat(a.preset, undefined, tl.format.fps);
      return { timeline: { ...tl, format, captions: { ...tl.captions, style: { ...tl.captions.style, posY: defaultCaptionY(format) } } }, label };
    }
    case 'denoise': {
      if (!tl.clips.length) throw new Error('A timeline está vazia.');
      const level = a.level === 'strong' ? 'strong' : 'light';
      return { timeline: { ...tl, clips: tl.clips.map((c) => ({ ...c, denoise: level })) }, label };
    }
    case 'pip':
    case 'broll': {
      const asset = ctx.assets[a.assetId];
      if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) throw new Error('Vídeo ou imagem não encontrado na biblioteca da marca.');
      const start = clamp(Number(a.start) || 0, 0, Math.max(0, total - 0.3));
      const want = a.duration ?? (asset.kind === 'video' ? asset.meta.duration ?? 4 : 3);
      const dur = Math.max(0.3, Math.min(want, asset.kind === 'video' ? asset.meta.duration ?? want : want, total - start));
      const used = (tl.layers ?? []).filter((l) => l.start < start + dur && l.start + (l.out - l.in) > start).map((l) => l.track);
      let track = 1;
      while (used.includes(track)) track++;
      const l = newLayer(asset.id, asset.kind === 'video' ? 'video' : 'image', dur, start, a.type === 'broll' ? 'cover' : 'free', track);
      if (a.type === 'broll') l.volume = 0;
      else {
        const pos = a.position ?? 'top-right';
        l.width = 0.42;
        l.x = pos === 'center' ? 0.5 : pos.endsWith('right') ? 0.72 : 0.28;
        l.y = pos === 'center' ? 0.5 : pos.startsWith('top') ? 0.3 : 0.68;
        const anim = a.anim ?? 'pop';
        // Entrada animada com quadros-chave (editáveis depois)
        const end = Math.min(0.35, dur / 3);
        const from = { x: l.x, y: l.y, scale: 1, rotation: 0, opacity: 1 };
        if (anim === 'fade') l.keyframes = [{ t: 0, ...from, opacity: 0 }, { t: end, ...from, ease: 'smooth' }];
        else if (anim === 'pop') l.keyframes = [{ t: 0, ...from, scale: 0.6, opacity: 0 }, { t: end, ...from, ease: 'smooth' }];
        else if (anim === 'slide') l.keyframes = [{ t: 0, ...from, x: l.x > 0.5 ? 1.3 : -0.3 }, { t: end, ...from, ease: 'smooth' }];
      }
      return { timeline: { ...tl, layers: [...(tl.layers ?? []), l] }, label };
    }
  }
  throw new Error('Ação desconhecida.');
}

export function textDefaults(kind: TextStyleKind, tl: Timeline, ctx?: ActionContext): Pick<TextClip, 'x' | 'y' | 'size' | 'color' | 'bg' | 'font'> {
  const accent = ctx?.brand.colors[0] ?? tl.captions.style.highlightColor;
  const font = ctx?.brand.font || tl.captions.style.font;
  if (kind === 'lower') return { x: 0.36, y: 0.8, size: 4.2, color: '#FFFFFF', bg: accent, font };
  if (kind === 'cta') return { x: 0.5, y: 0.55, size: 6, color: '#0B0B0C', bg: accent, font };
  return { x: 0.5, y: 0.3, size: 8, color: '#FFFFFF', bg: '', font };
}

/** Aplica um plano na ordem segura: marcações primeiro, cortes/velocidade de trás para frente, pausas por último. */
export function orderPlan(actions: EditAction[]): EditAction[] {
  const structural = (a: EditAction) => a.type === 'cut' || a.type === 'speed';
  const late = (a: EditAction) => a.type === 'remove_pauses' || a.type === 'keep_only';
  const first = actions.filter((a) => !structural(a) && !late(a));
  const mid = actions.filter(structural).sort((x: any, y: any) => y.start - x.start);
  return [...first, ...mid, ...actions.filter(late)];
}

/** Catálogo enviado à IA (descrição do que o editor sabe fazer). */
export const ACTION_CATALOG = `Ações disponíveis (use somente estas; tempos em segundos da timeline ATUAL):
- remove_pauses {minGap?: número ≥0.3, padrão 0.6} — remove silêncios entre falas sem cortar palavras.
- cut {start, end} — remove um intervalo.
- keep_only {start, end} — mantém só o intervalo.
- captions {preset?: "highlight"|"pop"|"karaoke"|"classic"|"box", highlightColor?: "#RRGGBB", uppercase?: bool, position?: "top"|"middle"|"bottom"} — gera/estiliza legendas sincronizadas.
- logo {position?: "top-right"|"top-left"|"bottom-right"|"bottom-left"} — aplica o logo da marca.
- text {text, start, duration?, kind?: "title"|"lower"|"cta", anim?: "fade"|"pop"|"slide"} — título, lower third ou chamada.
- transitions {transition: "fade"|"flash"|"zoom", duration?: 0.2-2} — transição em todos os cortes.
- filter {preset: ${Object.keys(COLOR_PRESETS).map((k) => `"${k}"`).join('|')}} — filtro de cor em todo o vídeo.
- zoom {start, end, scale?: 1.05-1.5} — aproximação num trecho (ênfase).
- dynamic_zoom {} — zoom suave alternado em todos os trechos (ritmo).
- speed {start, end, speed: 0.25-4}.
- music {assetId, volume?: 0-1, ducking?: bool} — trilha de fundo da biblioteca, abaixa na fala.
- format {preset: "9:16"|"16:9"|"1:1"|"4:5"}.
- denoise {level?: "light"|"strong"} — reduz chiado/ruído de fundo da fala (light para ruído leve).
- pip {assetId, start, duration?, position?: "top-right"|"top-left"|"bottom-right"|"bottom-left"|"center", anim?: "fade"|"pop"|"slide"|"none"} — vídeo/imagem da biblioteca em janela sobre o vídeo, com entrada animada.
- broll {assetId, start, duration?} — vídeo/imagem cobrindo a tela enquanto a fala principal continua (ilustra o que é dito).`;
