// Efeitos com a MESMA matemática na prévia (CSS/SVG) e na exportação (FFmpeg):
// filtros de cor, zoom animado, transições, ducking da música e remoção de pausas.
import type { CaptionWord, ColorAdjust, Timeline, TransitionType, VideoClip } from './types.ts';
import { clipDuration, layoutClips, OVERLAP_TRANSITIONS, rippleDelete } from './timeline.ts';
import { mapCuesToTimeline } from './captions.ts';

// ---------- Filtros de cor ----------

export const COLOR_PRESETS: Record<string, { label: string; v: Omit<ColorAdjust, 'preset'> }> = {
  none: { label: 'Original', v: { brightness: 1, contrast: 1, saturation: 1, temperature: 0 } },
  cinema: { label: 'Cinema', v: { brightness: 0.97, contrast: 1.12, saturation: 0.85, temperature: -0.15 } },
  vivido: { label: 'Vívido', v: { brightness: 1.02, contrast: 1.1, saturation: 1.35, temperature: 0.05 } },
  quente: { label: 'Quente', v: { brightness: 1.03, contrast: 1.04, saturation: 1.1, temperature: 0.5 } },
  frio: { label: 'Frio', v: { brightness: 1, contrast: 1.04, saturation: 0.95, temperature: -0.5 } },
  suave: { label: 'Suave', v: { brightness: 1.05, contrast: 0.9, saturation: 0.9, temperature: 0.1 } },
  pb: { label: 'Preto e branco', v: { brightness: 1, contrast: 1.15, saturation: 0, temperature: 0 } },
};

export function colorFromPreset(preset: string): ColorAdjust {
  return { preset, ...(COLOR_PRESETS[preset] ?? COLOR_PRESETS.none).v };
}

export function isNeutral(c?: ColorAdjust): boolean {
  return !c || (c.brightness === 1 && c.contrast === 1 && c.saturation === 1 && c.temperature === 0);
}

/** Etapa 1: afim por canal (brilho e contraste). Etapa 2: matriz 3x3 (saturação e temperatura). */
export function colorMath(c: ColorAdjust) {
  const slope = c.brightness * c.contrast;
  const intercept = 0.5 * (1 - c.contrast);
  const s = c.saturation;
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722];
  const S = [
    [lr + (1 - lr) * s, lg - lg * s, lb - lb * s],
    [lr - lr * s, lg + (1 - lg) * s, lb - lb * s],
    [lr - lr * s, lg - lg * s, lb + (1 - lb) * s],
  ];
  const T = [1 + 0.12 * c.temperature, 1, 1 - 0.12 * c.temperature];
  const M = S.map((row, i) => row.map((v) => v * T[i]));
  return { slope, intercept, M };
}

const r4 = (n: number) => Number(n.toFixed(4));

/** Cadeia de filtros do FFmpeg (entrada/saída em yuv). */
export function colorFfmpeg(c: ColorAdjust): string {
  const { slope, intercept, M } = colorMath(c);
  const e = `clip(val*${r4(slope)}+${r4(intercept * 255)}\\,0\\,255)`;
  const mix = ['r', 'g', 'b'].flatMap((o, i) => ['r', 'g', 'b'].map((n, j) => `${o}${n}=${r4(M[i][j])}`)).join(':');
  return `format=rgb24,lutrgb=r='${e}':g='${e}':b='${e}',colorchannelmixer=${mix}`;
}

/** Filtro SVG equivalente (para a prévia). */
export function colorSvg(c: ColorAdjust): { slope: number; intercept: number; matrix: string } {
  const { slope, intercept, M } = colorMath(c);
  const matrix = M.map((row) => `${row.map(r4).join(' ')} 0 0`).join(' ') + ' 0 0 0 1 0';
  return { slope: r4(slope), intercept: r4(intercept), matrix };
}

// ---------- Zoom e transições ----------

export const TRANSITIONS: Record<TransitionType, string> = { fade: 'Escurecer', flash: 'Flash branco', zoom: 'Zoom', dissolve: 'Dissolver (cruzada)', wipe: 'Cortina (cruzada)', slide: 'Deslizar (cruzada)' };
/** Nome no filtro xfade do FFmpeg. */
export const XFADE: Record<string, string> = { dissolve: 'fade', wipe: 'wipeleft', slide: 'slideleft' };

/** Transição cruzada no instante t: u (0..1) e como desenhar o trecho que sai e o que entra (prévia ⇔ xfade). */
export function crossAt(type: TransitionType, u: number): { out: { opacity: number; clip: string; tx: number }; in: { opacity: number; clip: string; tx: number } } {
  const k = Math.min(1, Math.max(0, u));
  if (type === 'wipe') return { out: { opacity: 1, clip: 'none', tx: 0 }, in: { opacity: 1, clip: `inset(0 0 0 ${((1 - k) * 100).toFixed(3)}%)`, tx: 0 } };
  if (type === 'slide') return { out: { opacity: 1, clip: 'none', tx: -k * 100 }, in: { opacity: 1, clip: 'none', tx: (1 - k) * 100 } };
  return { out: { opacity: 1, clip: 'none', tx: 0 }, in: { opacity: k, clip: 'none', tx: 0 } };
}
const ZOOM_PUNCH = 0.3;

export interface ClipFx {
  D: number;
  head: { type: TransitionType; d: number } | null;
  tail: { type: TransitionType; d: number } | null;
}

/** Metade da transição fica no fim do trecho anterior e metade no início do seguinte. */
export function clipFx(clips: VideoClip[], i: number): ClipFx {
  const c = clips[i];
  const D = clipDuration(c);
  const next = clips[i + 1];
  const half = (t?: { type: TransitionType; duration: number }, maxD = D) => (t && !OVERLAP_TRANSITIONS.has(t.type) ? { type: t.type, d: Math.min(t.duration / 2, maxD / 2) } : null);
  return { D, head: i > 0 ? half(c.transition) : null, tail: next ? half(next.transition, Math.min(D, clipDuration(next))) : null };
}

/** Fator de zoom no instante t (segundos desde o início do trecho). */
export function zoomAt(c: VideoClip, fx: ClipFx, t: number): number {
  const z = c.zoom ? c.zoom.from + (c.zoom.to - c.zoom.from) * Math.min(1, Math.max(0, t / fx.D)) : 1;
  const h = fx.head?.type === 'zoom' ? 1 + ZOOM_PUNCH * Math.max(0, 1 - t / fx.head.d) : 1;
  const tl = fx.tail?.type === 'zoom' ? 1 + ZOOM_PUNCH * Math.max(0, (t - (fx.D - fx.tail.d)) / fx.tail.d) : 1;
  return z * h * tl;
}

/** Mesma fórmula de zoomAt, como expressão do FFmpeg (variável t). */
export function zoomExpr(c: VideoClip, fx: ClipFx, t = 't'): string | null {
  const parts: string[] = [];
  if (c.zoom && (c.zoom.from !== 1 || c.zoom.to !== 1)) parts.push(`(${r4(c.zoom.from)}+${r4(c.zoom.to - c.zoom.from)}*min(1\\,${t}/${r4(fx.D)}))`);
  if (fx.head?.type === 'zoom') parts.push(`(1+${ZOOM_PUNCH}*max(0\\,1-${t}/${r4(fx.head.d)}))`);
  if (fx.tail?.type === 'zoom') parts.push(`(1+${ZOOM_PUNCH}*max(0\\,(${t}-${r4(fx.D - fx.tail.d)})/${r4(fx.tail.d)}))`);
  return parts.length ? parts.join('*') : null;
}

/** Cobertura (0..1) de preto/branco no instante t do trecho. */
export function fadeAt(fx: ClipFx, t: number): { color: 'black' | 'white'; alpha: number } | null {
  if (fx.head && fx.head.type !== 'zoom' && t < fx.head.d) return { color: fx.head.type === 'flash' ? 'white' : 'black', alpha: 1 - t / fx.head.d };
  if (fx.tail && fx.tail.type !== 'zoom' && t > fx.D - fx.tail.d) return { color: fx.tail.type === 'flash' ? 'white' : 'black', alpha: (t - (fx.D - fx.tail.d)) / fx.tail.d };
  return null;
}

// ---------- Música: ducking pela fala ----------

/** Intervalos da timeline com fala (a partir das legendas), unidos quando próximos. */
export function speechIntervals(tl: Timeline): [number, number][] {
  const words = mapCuesToTimeline({ ...tl, captions: { ...tl.captions, enabled: true } }).flatMap((c) => c.words);
  words.sort((a, b) => a.start - b.start);
  const out: [number, number][] = [];
  for (const w of words) {
    const a = Math.max(0, w.start - 0.15);
    const b = w.end + 0.25;
    const last = out[out.length - 1];
    if (last && a - last[1] < 0.5) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [r4(a), r4(b)]);
}

export function musicGainAt(tl: Timeline, t: number, total: number, intervals: [number, number][]): number {
  const m = tl.music;
  if (!m) return 0;
  let g = m.volume;
  if (m.ducking && intervals.some(([a, b]) => t >= a && t <= b)) g *= m.duckLevel;
  if (m.fadeIn > 0 && t < m.fadeIn) g *= t / m.fadeIn;
  if (m.fadeOut > 0 && t > total - m.fadeOut) g *= Math.max(0, (total - t) / m.fadeOut);
  return g;
}

// ---------- Remoção de pausas ----------

/** Trechos (tempo da timeline) sem fala que podem ser removidos sem cortar palavras. */
export function findPauses(tl: Timeline, transcripts: Record<string, CaptionWord[]>, minGap = 0.6, pad = 0.12): [number, number][] {
  const ranges: [number, number][] = [];
  for (const p of layoutClips(tl.clips)) {
    const words = (transcripts[p.clip.assetId] ?? []).filter((w) => w.e > p.clip.in && w.s < p.clip.out).sort((a, b) => a.s - b.s);
    if (!words.length) continue;
    const toTl = (s: number) => p.start + (s - p.clip.in) / p.clip.speed;
    const gaps: [number, number][] = [[p.clip.in, words[0].s]];
    for (let i = 0; i < words.length - 1; i++) gaps.push([words[i].e, words[i + 1].s]);
    gaps.push([words[words.length - 1].e, p.clip.out]);
    for (const [a, b] of gaps) {
      const s = Math.max(p.clip.in, a + pad);
      const e = Math.min(p.clip.out, b - pad);
      if (b - a >= minGap && e - s > 0.15) ranges.push([toTl(s), toTl(e)]);
    }
  }
  return ranges;
}

export function removePauses(tl: Timeline, transcripts: Record<string, CaptionWord[]>, minGap = 0.6): { timeline: Timeline; removed: number; seconds: number } {
  const ranges = findPauses(tl, transcripts, minGap).sort((a, b) => b[0] - a[0]);
  let cur = tl;
  for (const [a, b] of ranges) cur = rippleDelete(cur, a, b);
  return { timeline: cur, removed: ranges.length, seconds: ranges.reduce((n, [a, b]) => n + b - a, 0) };
}
