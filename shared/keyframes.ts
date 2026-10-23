// Faixas livres, quadros-chave e redução de ruído — MESMA matemática na prévia (CSS) e na exportação (FFmpeg).
import type { AudioClip, DenoiseLevel, Keyframe, LayerClip, OverlayClip, Timeline, Transform } from './types.ts';
import { clamp, uid } from './timeline.ts';

export const PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export type Prop = (typeof PROPS)[number];
export const KF_EPS = 1 / 30;

const smooth = (u: number) => u * u * (3 - 2 * u);

export function sortKfs(kfs?: Keyframe[]): Keyframe[] {
  return [...(kfs ?? [])].sort((a, b) => a.t - b.t);
}

/** Valores no instante t (segundos desde o início do item). Antes do 1º/depois do último quadro, mantém o valor. */
export function transformAt(base: Transform, kfs: Keyframe[] | undefined, t: number): Transform {
  const k = sortKfs(kfs);
  if (!k.length) return { x: base.x, y: base.y, scale: base.scale, rotation: base.rotation, opacity: base.opacity };
  const pick = (f: Keyframe): Transform => ({ x: f.x, y: f.y, scale: f.scale, rotation: f.rotation, opacity: f.opacity });
  if (t <= k[0].t) return pick(k[0]);
  for (let i = 1; i < k.length; i++) {
    if (t < k[i].t) {
      const a = k[i - 1];
      const b = k[i];
      let u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      if (b.ease === 'smooth') u = smooth(u);
      const out = {} as Transform;
      for (const p of PROPS) out[p] = a[p] + (b[p] - a[p]) * u;
      return out;
    }
  }
  return pick(k[k.length - 1]);
}

export const overlayBase = (o: OverlayClip): Transform => ({ x: o.x, y: o.y, scale: 1, rotation: o.rotation ?? 0, opacity: o.opacity });

/** Altera propriedades no instante t: sem quadros-chave muda o valor fixo; com quadros-chave cria/atualiza o quadro em t. */
export function setAt<T extends { keyframes?: Keyframe[] } & Partial<Transform>>(item: T, base: Transform, start: number, time: number, patch: Partial<Transform>): T {
  if (!item.keyframes?.length) return { ...item, ...patch };
  const t = Math.max(0, time - start);
  const cur = transformAt(base, item.keyframes, t);
  const k = sortKfs(item.keyframes);
  const i = k.findIndex((f) => Math.abs(f.t - t) < KF_EPS);
  if (i >= 0) k[i] = { ...k[i], ...patch };
  else k.push({ t, ...cur, ...patch, ease: 'smooth' });
  return { ...item, keyframes: sortKfs(k) };
}

export function addKeyframe<T extends { keyframes?: Keyframe[] }>(item: T, base: Transform, start: number, time: number): T {
  const t = Math.max(0, time - start);
  const k = sortKfs(item.keyframes).filter((f) => Math.abs(f.t - t) >= KF_EPS);
  // O primeiro quadro guarda o estado atual; os seguintes partem do valor interpolado.
  k.push({ t, ...transformAt(base, item.keyframes, t), ease: 'smooth' });
  return { ...item, keyframes: sortKfs(k) };
}

export function isAnimated(kfs: Keyframe[] | undefined, p: Prop): boolean {
  const k = kfs ?? [];
  return k.length > 1 && k.some((f) => Math.abs(f[p] - k[0][p]) > 1e-6);
}

const n = (v: number) => Number(v.toFixed(5)).toString();

/**
 * Expressão do FFmpeg para uma propriedade, em função de T (tempo da timeline).
 * `t0` = início do item; vírgulas escapadas para uso dentro do filter_complex.
 */
export function kfExpr(base: Transform, kfs: Keyframe[] | undefined, p: Prop, t0: number, T = 't'): string {
  const k = sortKfs(kfs);
  if (!isAnimated(k, p)) return n(k.length ? k[0][p] : base[p]);
  const lt = `(${T}-${n(t0)})`;
  let e = n(k[k.length - 1][p]);
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1];
    const b = k[i];
    const u = `clip((${lt}-${n(a.t)})/${n(Math.max(1e-6, b.t - a.t))}\\,0\\,1)`;
    const uu = b.ease === 'smooth' ? `(${u}*${u}*(3-2*${u}))` : u;
    e = `if(lt(${lt}\\,${n(b.t)})\\,${n(a[p])}+(${n(b[p] - a[p])})*${uu}\\,${e})`;
  }
  return `if(lt(${lt}\\,${n(k[0].t)})\\,${n(k[0][p])}\\,${e})`;
}

/** Comandos (sendcmd) para animar a opacidade: amostras a cada `step` segundos durante as rampas. */
export function opacityCommands(base: Transform, kfs: Keyframe[] | undefined, t0: number, t1: number, target: string, step = 1 / 15): string {
  const out: string[] = [];
  let last = -1;
  for (let t = t0; t <= t1 + 1e-6; t += step) {
    const v = clamp(transformAt(base, kfs, t - t0).opacity, 0, 1);
    if (Math.abs(v - last) < 0.004) continue;
    out.push(`${n(t)} ${target} aa ${n(v)}`);
    last = v;
  }
  return out.join(';');
}

export const maxScale = (base: Transform, kfs?: Keyframe[]) => Math.max(base.scale, ...(kfs ?? []).map((f) => f.scale));

// ---------- Faixas ----------

export const layerDuration = (l: LayerClip | AudioClip) => Math.max(0.05, l.out - l.in);
export const layerEnd = (l: LayerClip | AudioClip) => l.start + layerDuration(l);

/** Faixas de vídeo em ordem de empilhamento (de baixo para cima). */
export function stackedLayers(tl: Timeline): LayerClip[] {
  return [...(tl.layers ?? [])].sort((a, b) => a.track - b.track || a.start - b.start);
}

export function newLayer(assetId: string, kind: 'video' | 'image', duration: number, start: number, mode: 'free' | 'cover', track: number): LayerClip {
  return {
    id: uid('l_'), assetId, track, start, in: 0, out: duration, mode,
    width: mode === 'cover' ? 1 : 0.42, x: mode === 'cover' ? 0.5 : 0.7, y: mode === 'cover' ? 0.5 : 0.3,
    scale: 1, rotation: 0, opacity: 1, volume: kind === 'video' && mode === 'free' ? 1 : 0, keyframes: [],
  };
}

/** Ganho de um clipe de áudio no instante t da timeline (fades lineares — iguais ao afade do FFmpeg). */
export function audioClipGain(a: AudioClip, t: number): number {
  const lt = t - a.start;
  const d = layerDuration(a);
  if (lt < 0 || lt > d) return 0;
  let g = a.volume;
  if (a.fadeIn > 0 && lt < a.fadeIn) g *= lt / a.fadeIn;
  if (a.fadeOut > 0 && lt > d - a.fadeOut) g *= Math.max(0, (d - lt) / a.fadeOut);
  return g;
}

// ---------- Redução de ruído ----------

export const DENOISE_LABEL: Record<DenoiseLevel, string> = { light: 'Leve (chiado, ar-condicionado)', strong: 'Forte (ruído alto constante)' };

/** Cadeia de áudio do FFmpeg (mesma na exportação e na amostra tratada). */
export function denoiseFilter(level?: DenoiseLevel): string {
  if (!level) return '';
  return level === 'strong' ? 'highpass=f=80,afftdn=nr=24:nf=-30:tn=1,lowpass=f=12000' : 'highpass=f=70,afftdn=nr=12:nf=-40:tn=1';
}
