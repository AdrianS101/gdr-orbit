// Cortes de Reels a partir de uma entrevista e ritmo de edição por referência — regras puras.
import type { CaptionWord, Timeline } from './types.ts';
import { clamp, layoutClips, sourceTimeAt, splitAt } from './timeline.ts';

export interface Sentence {
  i: number;
  s: number;
  e: number;
  text: string;
}

/** Agrupa as palavras em frases (pontuação final ou pausa longa). Os cortes só acontecem nessas fronteiras. */
export function splitSentences(words: CaptionWord[], pause = 0.7, maxLen = 18): Sentence[] {
  const out: Sentence[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ i: out.length, s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map((w) => w.text.trim()).join(' ') });
    cur = [];
  };
  words.forEach((w, k) => {
    cur.push(w);
    const next = words[k + 1];
    const end = /[.!?…]["”')]*$/.test(w.text.trim());
    const gap = next ? next.s - w.e : Infinity;
    if (end || gap >= pause || cur[cur.length - 1].e - cur[0].s >= maxLen) flush();
  });
  flush();
  return out;
}

/** Trecho do original para as frases [from..to], com respiro curto antes e depois (sem invadir a frase vizinha). */
export function sentenceRange(sents: Sentence[], from: number, to: number, duration: number): { in: number; out: number } {
  const a = sents[from];
  const b = sents[to];
  const prevEnd = sents[from - 1]?.e ?? 0;
  const nextStart = sents[to + 1]?.s ?? duration;
  return {
    in: Math.max(prevEnd, a.s - 0.15, 0),
    out: Math.min(nextStart, b.e + 0.3, duration),
  };
}

export interface ReelPick {
  from: number;
  to: number;
  title: string;
  hook: string;
  why: string;
  /** Modo viral: frase de impacto DENTRO do trecho usada como abertura (cold open); -1 = sem. */
  hookSentence?: number;
  score?: number;
  structure?: { inicio: string; meio: string; fim: string };
}

/** Abertura (cold open): só vale se a frase estiver dentro do trecho, não for a 1ª e durar até 7 s. */
export function hookRange(p: { from: number; to: number; hookSentence?: number }, sents: Sentence[], duration: number): { in: number; out: number } | null {
  const h = Math.round(Number(p.hookSentence ?? -1));
  if (!(h > p.from && h <= p.to)) return null;
  const s = sents[h];
  if (!s || s.e - s.s > 7 || s.e - s.s < 1.2) return null;
  return sentenceRange(sents, h, h, duration);
}

/** Estilo de legenda dos cortes virais: grande, centralizada, 2–3 palavras por vez, palavra falada em destaque. */
export const VIRAL_CAPTION = { preset: 'highlight' as const, uppercase: true, bold: true, size: 9, maxWordsPerCue: 3, maxCharsPerLine: 14, outline: 12, shadow: 2, posY: 0.62 };

/** Valida a escolha da IA: índices válidos, sem sobreposição, duração dentro do limite (tira frases do fim se passar). */
export function sanitizePicks(picks: ReelPick[], sents: Sentence[], minDur: number, maxDur: number): (ReelPick & { start: number; end: number; warning: string | null })[] {
  const out: (ReelPick & { start: number; end: number; warning: string | null })[] = [];
  for (const p of picks) {
    let from = clamp(Math.round(Number(p.from)), 0, sents.length - 1);
    let to = clamp(Math.round(Number(p.to)), from, sents.length - 1);
    while (to > from && sents[to].e - sents[from].s > maxDur) to--;
    if (out.some((o) => !(to < o.from || from > o.to))) continue;
    const d = sents[to].e - sents[from].s;
    out.push({ ...p, from, to, start: sents[from].s, end: sents[to].e, warning: d < minDur ? `Ficou com ${d.toFixed(0)} s, abaixo do mínimo pedido.` : d > maxDur ? `Uma única frase passa de ${maxDur} s.` : null });
  }
  return out;
}

// ---------- Ritmo ----------

export interface RhythmProfile {
  duration: number;
  cuts: number[];
  shots: number;
  avgShot: number;
  medianShot: number;
  cutsPerMinute: number;
  firstCut: number | null;
  wordsPerMinute: number | null;
}

export function rhythmFromCuts(duration: number, cuts: number[], wordsPerMinute: number | null = null): RhythmProfile {
  const cs = cuts.filter((c) => c > 0.2 && c < duration - 0.2).sort((a, b) => a - b);
  const bounds = [0, ...cs, duration];
  const lens = bounds.slice(1).map((b, i) => b - bounds[i]).sort((a, b) => a - b);
  const m = Math.floor(lens.length / 2);
  return {
    duration,
    cuts: cs,
    shots: lens.length,
    avgShot: duration / lens.length,
    medianShot: lens.length % 2 ? lens[m] : (lens[m - 1] + lens[m]) / 2,
    cutsPerMinute: (cs.length / Math.max(1, duration)) * 60,
    firstCut: cs[0] ?? null,
    wordsPerMinute,
  };
}

/** Mudanças visuais do projeto: cortes entre trechos, mudança de zoom e entrada de faixas livres. */
export function projectRhythm(tl: Timeline, transcripts: Record<string, CaptionWord[]> = {}): RhythmProfile {
  const placed = layoutClips(tl.clips);
  const total = placed.reduce((m, p) => Math.max(m, p.end), 0);
  const cuts = new Set<number>();
  placed.forEach((p, i) => i > 0 && cuts.add(Number(p.start.toFixed(2))));
  for (const l of tl.layers ?? []) {
    cuts.add(Number(l.start.toFixed(2)));
    cuts.add(Number((l.start + l.out - l.in).toFixed(2)));
  }
  let words = 0;
  for (const p of placed) words += (transcripts[p.clip.assetId] ?? []).filter((w) => w.s >= p.clip.in && w.e <= p.clip.out).length;
  return rhythmFromCuts(total, [...cuts], total > 0 && words ? (words / total) * 60 : null);
}

/**
 * Aplica um ritmo: divide os trechos a cada ~shotLength segundos (nas pausas entre palavras, nunca no meio de uma)
 * e alterna enquadramento normal / aproximado (punch-in), como os cortes de câmera do vídeo de referência.
 */
export function applyRhythm(tl: Timeline, transcripts: Record<string, CaptionWord[]>, shotLength: number, punch = 1.12): { timeline: Timeline; changes: number } {
  const L = clamp(shotLength, 0.8, 15);
  const splits: number[] = [];
  for (const p of layoutClips(tl.clips)) {
    const words = transcripts[p.clip.assetId] ?? [];
    for (let target = p.start + L; target < p.end - L * 0.6; target += L) {
      const s = sourceTimeAt(p, target);
      const win = 0.4 * L * p.clip.speed;
      // pausas entre palavras dentro do trecho, perto do alvo
      let best: number | null = null;
      for (let k = 0; k < words.length - 1; k++) {
        const g = (words[k].e + words[k + 1].s) / 2;
        if (g <= p.clip.in + 0.3 || g >= p.clip.out - 0.3 || Math.abs(g - s) > win) continue;
        if (best === null || Math.abs(g - s) < Math.abs(best - s)) best = g;
      }
      const inWord = words.some((w) => s > w.s && s < w.e);
      const src = best ?? (inWord ? null : s);
      if (src === null) continue;
      splits.push(p.start + (src - p.clip.in) / p.clip.speed);
    }
  }
  let cur = tl;
  for (const t of splits) cur = splitAt(cur, t).timeline;
  const clips = cur.clips.map((c, i) => ({ ...c, zoom: i % 2 === 0 ? undefined : { from: punch, to: punch } }));
  return { timeline: { ...cur, clips }, changes: splits.length };
}
