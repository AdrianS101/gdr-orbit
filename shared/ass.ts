// Gera o arquivo ASS (Advanced SubStation Alpha) das legendas.
// O mesmo arquivo é renderizado pela libass na prévia (WASM) e na exportação (FFmpeg),
// garantindo que fonte, posição, quebras e animações fiquem idênticas.

import type { CaptionStyle, TextClip, Timeline } from './types.ts';
import { mapCuesToTimeline, wrapLines, type DisplayCue } from './captions.ts';

function assColor(hex: string, opacity = 1): string {
  const h = hex.replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const a = Math.round(255 * (1 - Math.min(1, Math.max(0, opacity))))
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escapeText(t: string): string {
  return t.replace(/[{}\\]/g, '');
}

export function captionFontPx(style: CaptionStyle, width: number, height: number): number {
  return Math.round((style.size / 100) * Math.min(width, height));
}

export function buildAss(tl: Timeline): string {
  const { width: W, height: H } = tl.format;
  const st = tl.captions.style;
  const fontPx = captionFontPx(st, W, H);
  const outline = st.preset === 'box' ? Math.round(fontPx * 0.22) : Math.round((fontPx * st.outline) / 100);
  const shadow = Math.round((fontPx * st.shadow) / 100);
  const isBox = st.preset === 'box';
  const primary = assColor(st.textColor);
  const outlineCol = isBox ? assColor(st.boxColor, st.boxOpacity) : assColor(st.outlineColor);
  const back = isBox ? assColor(st.boxColor, st.boxOpacity) : assColor('#000000', 0.55);

  const header = [
    '[Script Info]',
    'Title: GDR Orbit',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Main,${st.font},${fontPx},${primary},${primary},${outlineCol},${back},${st.bold ? -1 : 0},0,0,0,100,100,0,0,${isBox ? 3 : 1},${outline},${shadow},5,0,0,0,1`,
    `Style: TxtLine,${st.font},${fontPx},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${Math.round(fontPx * 0.08)},0,5,0,0,0,1`,
    `Style: TxtBox,${st.font},${fontPx},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,${Math.round(fontPx * 0.25)},0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const lines: string[] = [];
  if (tl.captions.enabled) {
    const x = Math.round(W / 2);
    const y = Math.round(st.posY * H);
    for (const cue of mapCuesToTimeline(tl)) lines.push(...cueEvents(cue, st, x, y));
  }
  for (const t of tl.texts ?? []) lines.push(textEvent(t, W, H));
  return header.concat(lines).join('\n') + '\n';
}

/** Títulos, lower thirds e chamadas (camada acima das legendas). */
function textEvent(t: TextClip, W: number, H: number): string {
  const px = Math.round((t.size / 100) * Math.min(W, H));
  const x = Math.round(t.x * W);
  const y = Math.round(t.y * H);
  const box = !!t.bg;
  const style = box ? 'TxtBox' : 'TxtLine';
  const ms = Math.max(100, Math.round((t.end - t.start) * 1000));
  let anim = '';
  if (t.anim === 'fade') anim = '\\fad(250,250)';
  else if (t.anim === 'pop') anim = `\\fscx40\\fscy40\\t(0,${Math.min(220, ms / 2)},\\fscx100\\fscy100)\\fad(60,200)`;
  else if (t.anim === 'slide') anim = `\\move(${x - Math.round(W * 0.12)},${y},${x},${y},0,${Math.min(300, ms / 2)})\\fad(150,200)`;
  const pos = t.anim === 'slide' ? '' : `\\pos(${x},${y})`;
  const tags = `{\\an5${pos}\\fn${t.font}\\fs${px}\\b${/black|heavy/i.test(t.font) ? 0 : 1}\\c${assColor(t.color)}${box ? `\\3c${assColor(t.bg)}` : ''}${anim}}`;
  const text = escapeText(t.text).replace(/\r?\n/g, '\\N');
  return `Dialogue: 1,${assTime(t.start)},${assTime(t.end)},${style},,0,0,0,,${tags}${text}`;
}

function cueEvents(cue: DisplayCue, st: CaptionStyle, x: number, y: number): string[] {
  const words = cue.words.map((w) => ({ ...w, text: escapeText(st.uppercase ? w.text.toLocaleUpperCase('pt-BR') : w.text) }));
  const layout = wrapLines(words, st.maxCharsPerLine, cue.breaks);
  const pos = `{\\an5\\pos(${x},${y})}`;
  const base = assColor(st.textColor);
  const hl = assColor(st.highlightColor);

  const render = (active: number): string =>
    layout
      .map((line) =>
        line
          .map((k) => {
            const t = words[k].text;
            if (st.preset === 'karaoke' && k <= active) return `{\\c${hl}}${t}{\\c${base}}`;
            if (k !== active) return t;
            if (st.preset === 'highlight') return `{\\c${hl}}${t}{\\c${base}}`;
            if (st.preset === 'pop') return `{\\c${hl}\\fscx100\\fscy100\\t(0,90,\\fscx122\\fscy122)\\t(90,170,\\fscx112\\fscy112)}${t}{\\c${base}\\fscx100\\fscy100}`;
            return t;
          })
          .join(' '),
      )
      .join('\\N');

  if (st.preset === 'classic' || st.preset === 'box') {
    return [`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Main,,0,0,0,,${pos}{\\fad(70,0)}${render(-1)}`];
  }
  const out: string[] = [];
  words.forEach((w, k) => {
    const s = k === 0 ? cue.start : w.start;
    const e = k === words.length - 1 ? cue.end : words[k + 1].start;
    if (e - s < 0.01) return;
    out.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Main,,0,0,0,,${pos}${render(k)}`);
  });
  return out;
}
