// Legendas dentro do vídeo: geração a partir da transcrição, mapeamento para a timeline,
// edição de texto/tempo e importação/exportação SRT.
// As palavras ficam ancoradas no tempo do arquivo original, então cortes e reordenações
// não dessincronizam as legendas.

import type { CaptionCue, CaptionStyle, CaptionWord, Timeline } from './types.ts';
import { clipAt, layoutClips, uid, type PlacedClip } from './timeline.ts';

const SENTENCE_END = /[.!?…]$/;

export function cleanWord(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/** Agrupa palavras transcritas em blocos de legenda curtos e legíveis. */
export function buildCues(assetId: string, words: CaptionWord[], style: Pick<CaptionStyle, 'maxWordsPerCue' | 'maxCharsPerLine'>, range?: { from: number; to: number }[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: CaptionWord[] = [];
  const maxChars = style.maxCharsPerLine * 2;
  const flush = () => {
    if (cur.length) cues.push({ id: uid('q_'), assetId, words: cur });
    cur = [];
  };
  for (const raw of words) {
    const w = { text: cleanWord(raw.text), s: raw.s, e: Math.max(raw.e, raw.s + 0.04) };
    if (!w.text) continue;
    if (range && !range.some((r) => (w.s + w.e) / 2 >= r.from && (w.s + w.e) / 2 <= r.to)) continue;
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      if (w.s - prev.e > 0.6 || cur.length >= style.maxWordsPerCue || chars > maxChars || SENTENCE_END.test(prev.text)) flush();
    }
    cur.push(w);
  }
  flush();
  return cues;
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  index: number;
  k?: 1;
}

export interface DisplayCue {
  key: string;
  cueId: string;
  start: number;
  end: number;
  words: TimedWord[];
  breaks: number[];
}

/** Calcula quando cada legenda aparece na timeline atual. */
export function mapCuesToTimeline(tl: Timeline): DisplayCue[] {
  const placed = layoutClips(tl.clips);
  // Na transição cruzada os dois trechos aparecem juntos: a legenda passa de um para o outro no meio da sobreposição.
  const win = placed.map((p, i) => {
    const prev = placed[i - 1];
    const next = placed[i + 1];
    return { lo: prev && prev.end > p.start ? (p.start + prev.end) / 2 : -Infinity, hi: next && next.start < p.end ? (next.start + p.end) / 2 : Infinity };
  });
  const out: DisplayCue[] = [];
  for (const cue of tl.captions.cues) {
    // agrupa por ocorrência de trecho (um trecho duplicado mostra a legenda duas vezes)
    const groups = new Map<number, TimedWord[]>();
    cue.words.forEach((w, index) => {
      const mid = (w.s + w.e) / 2;
      for (const p of placed) {
        if (p.clip.assetId !== cue.assetId || mid < p.clip.in || mid >= p.clip.out) continue;
        const s = Math.max(w.s, p.clip.in);
        const e = Math.min(w.e, p.clip.out);
        const tm = p.start + (mid - p.clip.in) / p.clip.speed;
        if (tm < win[p.index].lo || tm >= win[p.index].hi) continue;
        const g = groups.get(p.index) ?? [];
        g.push({ ...(w.k ? { k: 1 as const } : {}), text: w.text, start: p.start + (s - p.clip.in) / p.clip.speed, end: p.start + (e - p.clip.in) / p.clip.speed, index });
        groups.set(p.index, g);
      }
    });
    let pending: DisplayCue | null = null;
    for (const [clipIndex, words] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const dc: DisplayCue = {
        key: `${cue.id}@${clipIndex}`,
        cueId: cue.id,
        start: words[0].start,
        end: words[words.length - 1].end,
        words,
        breaks: cue.breaks ?? [],
      };
      // junta partes da mesma legenda que ficaram coladas após um corte
      if (pending && dc.start - pending.end < 0.15) {
        pending.words.push(...dc.words);
        pending.end = dc.end;
      } else {
        if (pending) out.push(pending);
        pending = dc;
      }
    }
    if (pending) out.push(pending);
  }
  out.sort((a, b) => a.start - b.start);
  // estende levemente cada legenda para evitar piscadas, sem sobrepor a próxima
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const hold = out[i].end + 0.35;
    out[i].end = next ? Math.min(hold, Math.max(next.start, out[i].end)) : hold;
    if (next && out[i].end > next.start) out[i].end = next.start;
    if (out[i].end - out[i].start < 0.05) out[i].end = out[i].start + 0.05;
  }
  return out;
}

/** Quebra as palavras em linhas (índices), respeitando quebras manuais. */
export function wrapLines(words: { text: string; index: number }[], maxChars: number, manualBreaks: number[]): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  words.forEach((w, i) => {
    const add = (cur.length ? 1 : 0) + w.text.length;
    if (cur.length && len + add > maxChars) {
      lines.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += (cur.length > 1 ? 1 : 0) + w.text.length;
    if (manualBreaks.includes(w.index) && i < words.length - 1) {
      lines.push(cur);
      cur = [];
      len = 0;
    }
  });
  if (cur.length) lines.push(cur);
  // equilibra duas linhas muito desiguais
  if (lines.length === 2 && !manualBreaks.length) {
    const total = words.reduce((n, w) => n + w.text.length + 1, 0);
    let best = lines;
    let bestDiff = Infinity;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).reduce((n, w) => n + w.text.length + 1, 0);
      const b = total - a;
      if (a - 1 > maxChars || b - 1 > maxChars) continue;
      if (Math.abs(a - b) < bestDiff) {
        bestDiff = Math.abs(a - b);
        best = [words.slice(0, k).map((_, i) => i), words.slice(k).map((_, i) => i + k)];
      }
    }
    return best;
  }
  return lines;
}

export function cueText(cue: CaptionCue): string {
  const br = new Set(cue.breaks ?? []);
  return cue.words.map((w, i) => w.text + (br.has(i) && i < cue.words.length - 1 ? '\n' : '')).join(' ').replace(/\n /g, '\n');
}

/** Aplica um texto editado à legenda, preservando os tempos quando possível. */
export function setCueText(cue: CaptionCue, text: string): CaptionCue | null {
  const lines = text.split('\n').map((l) => l.trim().split(/\s+/).filter(Boolean));
  const tokens: string[] = [];
  const breaks: number[] = [];
  lines.forEach((l, li) => {
    tokens.push(...l);
    if (li < lines.length - 1 && l.length) breaks.push(tokens.length - 1);
  });
  if (!tokens.length) return null;
  if (tokens.length === cue.words.length) {
    return { ...cue, breaks, words: cue.words.map((w, i) => ({ ...w, text: tokens[i] })) };
  }
  const s = cue.words[0].s;
  const e = cue.words[cue.words.length - 1].e;
  return { ...cue, breaks, words: distribute(tokens, s, e) };
}

function distribute(tokens: string[], s: number, e: number): CaptionWord[] {
  const weights = tokens.map((t) => t.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = s;
  return tokens.map((text, i) => {
    const d = ((e - s) * weights[i]) / total;
    const w = { text, s: t, e: t + d };
    t += d;
    return w;
  });
}

/** Reposiciona o início/fim de uma legenda (tempo do original), escalando as palavras. */
export function setCueSpan(cue: CaptionCue, s: number, e: number): CaptionCue {
  const os = cue.words[0].s;
  const oe = cue.words[cue.words.length - 1].e;
  if (e - s < 0.05) e = s + 0.05;
  const k = (e - s) / Math.max(0.001, oe - os);
  return { ...cue, words: cue.words.map((w) => ({ ...w, s: s + (w.s - os) * k, e: s + (w.e - os) * k })) };
}

/** Junta uma legenda à seguinte. */
export function mergeCues(a: CaptionCue, b: CaptionCue): CaptionCue {
  const breaks = [...(a.breaks ?? []), ...(b.breaks ?? []).map((i) => i + a.words.length)];
  return { ...a, words: [...a.words, ...b.words], breaks };
}

// ---------- SRT ----------

function srtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

export function exportSrt(tl: Timeline): string {
  const cues = mapCuesToTimeline(tl);
  return cues
    .map((c, i) => {
      const lines = wrapLines(c.words, tl.captions.style.maxCharsPerLine, c.breaks).map((l) => l.map((k) => c.words[k].text).join(' '));
      return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

function parseSrtTime(s: string): number {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000;
}

/** Importa um SRT (tempos da timeline) ancorando cada bloco no trecho correspondente. */
export function importSrt(tl: Timeline, srt: string): { cues: CaptionCue[]; skipped: number } {
  const placed = layoutClips(tl.clips);
  const blocks = srt.replace(/\r/g, '').split(/\n\s*\n/);
  const cues: CaptionCue[] = [];
  let skipped = 0;
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map(parseSrtTime);
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    const p: PlacedClip | null = clipAt(placed, a);
    if (!p || !text || !isFinite(a) || !isFinite(z)) {
      skipped++;
      continue;
    }
    const s = p.clip.in + (a - p.start) * p.clip.speed;
    const e = Math.min(p.clip.out, p.clip.in + (Math.min(z, p.end) - p.start) * p.clip.speed);
    const base: CaptionCue = { id: uid('q_'), assetId: p.clip.assetId, words: [{ text: 'x', s, e }] };
    const cue = setCueText(base, text);
    if (cue) cues.push(cue);
  }
  return { cues, skipped };
}
