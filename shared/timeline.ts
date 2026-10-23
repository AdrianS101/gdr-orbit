// Regras da timeline: posicionamento dos trechos, mapeamento de tempo e operações de edição.
// Funções puras — usadas pela interface (edição/prévia) e pelo servidor (renderização).

import type { CaptionStyle, FormatPreset, OutputFormat, Timeline, VideoClip } from './types.ts';

export const MIN_CLIP = 0.1;

export const FORMAT_PRESETS: Record<Exclude<FormatPreset, 'custom'>, { label: string; width: number; height: number; hint: string }> = {
  '9:16': { label: 'Vertical 9:16', width: 1080, height: 1920, hint: 'Reels, TikTok, Shorts, Stories' },
  '16:9': { label: 'Horizontal 16:9', width: 1920, height: 1080, hint: 'YouTube, institucional, entrevistas' },
  '1:1': { label: 'Quadrado 1:1', width: 1080, height: 1080, hint: 'Feed' },
  '4:5': { label: 'Retrato 4:5', width: 1080, height: 1350, hint: 'Feed do Instagram' },
};

export function uid(prefix = ''): string {
  const r = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + r.replace(/-/g, '').slice(0, 16);
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  preset: 'highlight',
  font: 'Arial Black',
  size: 6.4,
  bold: false,
  uppercase: true,
  textColor: '#FFFFFF',
  highlightColor: '#FF7A00',
  outlineColor: '#000000',
  outline: 9,
  shadow: 0,
  boxColor: '#000000',
  boxOpacity: 0.6,
  posY: 0.68,
  maxCharsPerLine: 18,
  maxWordsPerCue: 4,
};

export function makeFormat(preset: FormatPreset, custom?: { width: number; height: number }, fps = 30): OutputFormat {
  if (preset === 'custom') {
    const w = even(clamp(custom?.width ?? 1080, 64, 4096));
    const h = even(clamp(custom?.height ?? 1920, 64, 4096));
    return { preset, width: w, height: h, fps };
  }
  const p = FORMAT_PRESETS[preset];
  return { preset, width: p.width, height: p.height, fps };
}

export function emptyTimeline(preset: FormatPreset = '9:16'): Timeline {
  const format = makeFormat(preset);
  return {
    version: 1,
    format,
    clips: [],
    overlays: [],
    captions: { enabled: true, style: { ...DEFAULT_CAPTION_STYLE, posY: defaultCaptionY(format) }, cues: [] },
    audio: { normalize: true },
  };
}

export function defaultCaptionY(f: OutputFormat): number {
  const ratio = f.height / f.width;
  if (ratio > 1.5) return 0.68; // vertical: acima da área de botões/legenda das redes
  if (ratio > 1.05) return 0.78;
  return 0.84;
}

export function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

export function even(n: number): number {
  return Math.round(n / 2) * 2;
}

export function clipDuration(c: VideoClip): number {
  return (c.out - c.in) / c.speed;
}

export interface PlacedClip {
  clip: VideoClip;
  index: number;
  start: number;
  end: number;
}

/** Posição de cada trecho na faixa magnética. */
export function layoutClips(clips: VideoClip[]): PlacedClip[] {
  let t = 0;
  return clips.map((clip, index) => {
    const d = clipDuration(clip);
    const p = { clip, index, start: t, end: t + d };
    t += d;
    return p;
  });
}

export function timelineDuration(tl: Timeline): number {
  const clipsEnd = layoutClips(tl.clips).reduce((m, p) => Math.max(m, p.end), 0);
  return clipsEnd;
}

export function clipAt(placed: PlacedClip[], t: number): PlacedClip | null {
  for (const p of placed) if (t >= p.start && t < p.end) return p;
  return null;
}

/** Tempo no arquivo original correspondente ao instante t da timeline dentro do trecho. */
export function sourceTimeAt(p: PlacedClip, t: number): number {
  return p.clip.in + (t - p.start) * p.clip.speed;
}

/** Converte um instante do arquivo original para todas as posições onde aparece na timeline. */
export function sourceToTimeline(placed: PlacedClip[], assetId: string, s: number): number[] {
  const out: number[] = [];
  for (const p of placed) {
    if (p.clip.assetId !== assetId) continue;
    if (s >= p.clip.in && s <= p.clip.out) out.push(p.start + (s - p.clip.in) / p.clip.speed);
  }
  return out;
}

// ---------- Operações (retornam uma nova timeline) ----------

export function splitAt(tl: Timeline, t: number): { timeline: Timeline; rightId: string | null } {
  const placed = layoutClips(tl.clips);
  const p = clipAt(placed, t);
  if (!p) return { timeline: tl, rightId: null };
  const cut = sourceTimeAt(p, t);
  if (cut - p.clip.in < MIN_CLIP || p.clip.out - cut < MIN_CLIP) return { timeline: tl, rightId: null };
  // O zoom animado continua do mesmo ponto; a transição fica só no início do trecho original.
  const zk = p.clip.zoom ? p.clip.zoom.from + (p.clip.zoom.to - p.clip.zoom.from) * ((cut - p.clip.in) / (p.clip.out - p.clip.in)) : 0;
  const left: VideoClip = { ...p.clip, out: cut, ...(p.clip.zoom ? { zoom: { from: p.clip.zoom.from, to: zk } } : {}) };
  const right: VideoClip = { ...p.clip, id: uid('c_'), in: cut, transition: undefined, ...(p.clip.zoom ? { zoom: { from: zk, to: p.clip.zoom.to } } : {}) };
  const clips = [...tl.clips];
  clips.splice(p.index, 1, left, right);
  return { timeline: { ...tl, clips }, rightId: right.id };
}

export function removeClip(tl: Timeline, id: string): Timeline {
  return { ...tl, clips: tl.clips.filter((c) => c.id !== id) };
}

export function duplicateClip(tl: Timeline, id: string): { timeline: Timeline; newId: string | null } {
  const i = tl.clips.findIndex((c) => c.id === id);
  if (i < 0) return { timeline: tl, newId: null };
  const copy = { ...tl.clips[i], id: uid('c_') };
  const clips = [...tl.clips];
  clips.splice(i + 1, 0, copy);
  return { timeline: { ...tl, clips }, newId: copy.id };
}

export function moveClip(tl: Timeline, id: string, toIndex: number): Timeline {
  const i = tl.clips.findIndex((c) => c.id === id);
  if (i < 0) return tl;
  const clips = [...tl.clips];
  const [c] = clips.splice(i, 1);
  clips.splice(clamp(toIndex, 0, clips.length), 0, c);
  return { ...tl, clips };
}

export function updateClip(tl: Timeline, id: string, patch: Partial<VideoClip>): Timeline {
  return { ...tl, clips: tl.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** Ajusta início/fim de um trecho respeitando os limites do arquivo. */
export function trimClip(tl: Timeline, id: string, edge: 'in' | 'out', value: number, sourceDuration: number): Timeline {
  return {
    ...tl,
    clips: tl.clips.map((c) => {
      if (c.id !== id) return c;
      if (edge === 'in') return { ...c, in: clamp(value, 0, c.out - MIN_CLIP) };
      return { ...c, out: clamp(value, c.in + MIN_CLIP, sourceDuration) };
    }),
  };
}

/** Remove um intervalo [a,b) da timeline (usado para cortar pausas). */
export function rippleDelete(tl: Timeline, a: number, b: number): Timeline {
  let cur = tl;
  const s1 = splitAt(cur, b);
  cur = s1.timeline;
  const s2 = splitAt(cur, a);
  cur = s2.timeline;
  const placed = layoutClips(cur.clips);
  const keep = placed.filter((p) => !(p.start >= a - 1e-6 && p.end <= b + 1e-6)).map((p) => p.clip);
  // Textos e elementos acompanham o corte.
  const d = b - a;
  const shift = (t: number) => (t >= b ? t - d : t > a ? a : t);
  const texts = cur.texts?.map((x) => ({ ...x, start: shift(x.start), end: shift(x.end) })).filter((x) => x.end - x.start > 0.05);
  const overlays = cur.overlays.map((o) => ({ ...o, start: shift(o.start), end: shift(o.end) })).filter((o) => o.end - o.start > 0.05);
  // Faixas livres acompanham pelo início (mantêm a duração).
  const layers = cur.layers?.map((l) => ({ ...l, start: shift(l.start) }));
  const audioClips = cur.audioClips?.map((l) => ({ ...l, start: shift(l.start) }));
  return { ...cur, clips: keep, overlays, ...(texts ? { texts } : {}), ...(layers ? { layers } : {}), ...(audioClips ? { audioClips } : {}) };
}

export function fmtTime(t: number, withMs = false): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!withMs) return base;
  const cs = Math.floor((t % 1) * 100);
  return `${base}.${String(cs).padStart(2, '0')}`;
}

/** Áreas cobertas pela interface das redes em vídeos verticais (frações do quadro). */
export const SAFE_AREAS_VERTICAL = { top: 0.12, bottom: 0.2, right: 0.14, left: 0.04 };
