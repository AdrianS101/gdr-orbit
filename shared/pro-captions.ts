// Legenda "Profissional" (especificação aprovada em 30/10/2026, cortes do Rodrigo Napoleão):
// cartelas de até 2 linhas — Poppins Bold em cima, Poppins Light embaixo (a 2ª linha só entra quando é falada) —
// e uma palavra de ênfase em Playfair Display ExtraBold Italic gigante com brilho branco. Letras quase encostando,
// entrada com fade + desfoque→nítido, saída com fade. Sem slide nem bounce.
// A libass ignora o espaçamento entre letras, então cada letra é posicionada pela largura lida do .ttf
// (shared/pro-fonts.ts). O mesmo ASS vai para a prévia e para a exportação.
import type { CaptionStyle } from './types.ts';
import { PRO_FONTS, type ProFont } from './pro-fonts.ts';

/** Palavra já no tempo da timeline. `k` = ênfase (palavra-chave). */
export interface ProWord { text: string; start: number; end: number; k?: 1 }

export interface Cartela { s: number; e: number; l1: string[]; l2: string[]; l2s: number | null; emph: { w: string; s: number } | null }

const MAX_CHARS = 20;
const PAUSE = 0.35;
/** Ênfases mais próximas que isso viram texto normal (densidade da especificação: 1 a cada 6–8 s). */
const MIN_EMPH_GAP = 4;

/** Monta as cartelas (seção 2 da especificação). `*palavra` = ênfase, `|palavra` = cartela nova. */
export function buildCartelas(words: ProWord[]): Cartela[] {
  const cards: Cartela[] = [];
  let cur: (Cartela & { last: number }) | null = null;
  let lastEmph = -Infinity;
  const open = (s: number) => ({ s, e: s, l1: [], l2: [], l2s: null, emph: null, last: s });
  const flush = () => {
    if (cur && (cur.l1.length || cur.l2.length || cur.emph)) cards.push({ s: cur.s, e: cur.e, l1: cur.l1, l2: cur.l2, l2s: cur.l2s, emph: cur.emph });
    cur = null;
  };
  let prevEnd: number | null = null;
  for (const raw of words) {
    let w = raw.text.trim();
    if (!w) continue;
    const force = w.startsWith('|');
    if (force) w = w.slice(1);
    let emph = w.startsWith('*') || !!raw.k;
    w = w.replace(/^\*/, '');
    if (!w) continue;
    if (emph && raw.start - lastEmph < MIN_EMPH_GAP) emph = false;
    const { start: s, end: e } = raw;
    if (cur && (force || (prevEnd !== null && s - prevEnd > PAUSE))) flush();
    prevEnd = e;
    if (emph) {
      if (!cur) cur = open(s);
      if (cur.emph || cur.l2.length) {
        flush();
        cur = open(s);
      }
      // vírgula e ponto somem na serifada; ? e ! ficam
      cur.emph = { w: w.replace(/[,.;:]+$/, ''), s };
      cur.e = e;
      lastEmph = s;
      if (/[.!?:]$/.test(w)) flush();
      continue;
    }
    if (!cur) cur = open(s);
    const len = (arr: string[]) => arr.join(' ').length;
    if (!cur.emph && !cur.l2.length && len([...cur.l1, w]) <= MAX_CHARS) cur.l1.push(w);
    else if (len([...cur.l2, w]) <= MAX_CHARS && !(cur.emph && cur.l2.length >= 3)) {
      if (!cur.l2.length) cur.l2s = s;
      cur.l2.push(w);
    } else {
      flush();
      cur = open(s);
      cur.l1.push(w);
    }
    cur.e = e;
    if (/[.!?:]$/.test(w) && cur.l2.length) flush();
  }
  flush();
  // fim = última palavra + 0,25 s, sem passar da próxima; buraco < 0,3 s é preenchido; a última ganha +0,4 s
  for (let i = 0; i < cards.length; i++) {
    const nx = cards[i + 1];
    cards[i].e = nx ? Math.min(cards[i].e + 0.25, nx.s) : cards[i].e + 0.4;
    if (nx && nx.s - cards[i].e < 0.3) cards[i].e = nx.s;
  }
  return cards;
}

// ---- tipografia (valores para 1080 de largura no vertical; escala pelo menor lado do quadro) ----
const TYPE = {
  Linha1: { font: PRO_FONTS.bold, size: 118, track: -7, space: 0.55 },
  Linha2: { font: PRO_FONTS.light, size: 112, track: -6, space: 0.55 },
  Enfase: { font: PRO_FONTS.emph, size: 200, track: -6, space: 0.6 },
} as const;
type StyleName = keyof typeof TYPE;

function advance(font: ProFont, ch: string, size: number): number {
  const w = font.widths[ch.codePointAt(0)!] ?? font.widths[110] ?? font.height / 2; // fora da tabela: largura do "n"
  return (w * size) / font.height;
}

/** Posição x (esquerda) de cada letra, centralizando a linha em cx; reduz por igual se passar de maxW. */
export function layoutLetters(style: StyleName, cx: number, text: string, k: number, maxW: number) {
  const st = TYPE[style];
  const size = st.size * k;
  const track = st.track * k;
  const out: { ch: string; x: number }[] = [];
  let x = 0;
  for (const ch of text) {
    if (ch !== ' ') out.push({ ch, x });
    x += ch === ' ' ? advance(st.font, ch, size) * st.space : advance(st.font, ch, size) + track;
  }
  const width = x - track;
  const f = Math.min(1, maxW / width);
  const x0 = cx - (f * width) / 2;
  const scale = f < 1 ? `\\fscx${Math.round(f * 100)}\\fscy${Math.round(f * 100)}` : '';
  return out.map((l) => ({ ch: l.ch, x: Math.round(x0 + f * l.x), scale }));
}

const FADE_IN = 90;
const FADE_OUT = 110;
const clean = (s: string) => s.replace(/[{}\\]/g, '');

export function proStyles(k: number): string[] {
  const s = (n: number) => Math.round(n * k);
  return [
    `Style: ProL1,${PRO_FONTS.bold.family},${s(118)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: ProL2,${PRO_FONTS.light.family},${s(112)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: ProEmph,${PRO_FONTS.emph.family},${s(200)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
  ];
}

/** Eventos ASS da legenda profissional. `posY` = centro da linha 1 (fração da altura; aprovado ≈ 0,646). */
export function proCaptionEvents(words: ProWord[], st: Pick<CaptionStyle, 'posY'>, W: number, H: number, time: (t: number) => string): string[] {
  const k = Math.min(W, H) / 1080;
  const cx = Math.round(W / 2);
  const maxW = Math.min(W - 40 * k, 980 * k);
  const y1 = Math.round(st.posY * H);
  const ev: string[] = [];
  const line = (style: 'Linha1' | 'Linha2', assStyle: string, y: number, s: number, e: number, txt: string) => {
    const blurIn = `\\blur${(5 * k).toFixed(1)}\\t(0,${FADE_IN + 40},\\blur0)`;
    for (const l of layoutLetters(style, cx, clean(txt), k, maxW)) {
      // sombra suave (37%, +3/+4 px, desfoque 9) atrás de cada letra, depois a letra entrando "focando"
      ev.push(`Dialogue: 0,${time(s)},${time(e)},${assStyle},,0,0,0,,{\\an4\\pos(${l.x + Math.round(3 * k)},${y + Math.round(4 * k)})\\fad(${FADE_IN},${FADE_OUT})\\1c&H000000&\\1a&HA0&\\blur${Math.round(9 * k)}${l.scale}}${l.ch}`);
      ev.push(`Dialogue: 1,${time(s)},${time(e)},${assStyle},,0,0,0,,{\\an4\\pos(${l.x},${y})\\fad(${FADE_IN},${FADE_OUT})${blurIn}${l.scale}}${l.ch}`);
    }
  };
  for (const c of buildCartelas(words)) {
    let y = y1;
    if (c.l1.length) {
      line('Linha1', 'ProL1', y, c.s, c.e, c.l1.join(' '));
      y += Math.round(60 * k);
    }
    if (c.emph) {
      const ey = c.l1.length ? y + Math.round(40 * k) : y;
      for (const l of layoutLetters('Enfase', cx, clean(c.emph.w), k, maxW)) {
        // brilho branco (cópia da palavra, 56%, desfoque 14) + a palavra entrando com desfoque 6 → 0,6
        ev.push(`Dialogue: 0,${time(c.emph.s)},${time(c.e)},ProEmph,,0,0,0,,{\\an4\\pos(${l.x},${ey})\\fad(${FADE_IN},${FADE_OUT})\\1a&H70&\\blur${Math.round(14 * k)}${l.scale}}${l.ch}`);
        ev.push(`Dialogue: 1,${time(c.emph.s)},${time(c.e)},ProEmph,,0,0,0,,{\\an4\\pos(${l.x},${ey})\\fad(${FADE_IN},${FADE_OUT})\\blur${(6 * k).toFixed(1)}\\t(0,160,\\blur${(0.6 * k).toFixed(1)})${l.scale}}${l.ch}`);
      }
      y = ey + Math.round(100 * k);
    }
    if (c.l2.length) line('Linha2', 'ProL2', y, c.l2s ?? c.s, c.e, c.l2.join(' '));
  }
  return ev;
}

/** Fontes que a prévia e a exportação precisam carregar para este estilo. */
export const PRO_FONT_FAMILIES = [
  { family: PRO_FONTS.bold.family, bold: true },
  { family: PRO_FONTS.light.family, bold: false },
  { family: PRO_FONTS.emph.family, bold: false },
];

// ---- ênfase automática (1 clique): ~1 palavra forte a cada 6–8 s ----
const STOP = new Set('para porque quando sobre entre ainda depois antes muito muita muitos muitas mesmo mesma assim então também sempre nunca outra outro outras outros todos todas tudo nada coisa coisas aquele aquela aquilo estava estavam estou estão sendo tinha tenho temos fazer feito fazendo vamos pessoa pessoas gente aqui agora hoje'.split(' '));

/** Escolhe as palavras de ênfase: substantivos/conceitos longos, de preferência a que fecha a ideia. */
export function pickEmphasis(words: ProWord[], every = 7): number[] {
  const picks: number[] = [];
  let last = -Infinity;
  let best: { i: number; score: number } | null = null;
  let windowEnd = (words[0]?.start ?? 0) + every;
  const norm = (t: string) => t.toLocaleLowerCase('pt-BR').replace(/[^\p{L}]/gu, '');
  const commit = () => {
    if (best && words[best.i].start - last >= MIN_EMPH_GAP + 1) {
      picks.push(best.i);
      last = words[best.i].start;
    }
    best = null;
  };
  words.forEach((w, i) => {
    if (w.start > windowEnd) {
      commit();
      while (w.start > windowEnd) windowEnd += every;
    }
    const n = norm(w.text);
    if (n.length < 6 || STOP.has(n) || /mente$/.test(n) || /^\d/.test(w.text)) return;
    const score = Math.min(n.length, 11) + (/[.!?]$/.test(w.text.trim()) ? 4 : /[,;:]$/.test(w.text.trim()) ? 2 : 0);
    if (!best || score > best.score) best = { i, score };
  });
  commit();
  return picks;
}
