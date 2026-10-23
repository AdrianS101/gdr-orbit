import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRhythm, projectRhythm, rhythmFromCuts, sanitizePicks, sentenceRange, splitSentences } from '../shared/studio.ts';
import { emptyTimeline, layoutClips } from '../shared/timeline.ts';
import type { CaptionWord } from '../shared/types.ts';

// 3 frases: "Olá pessoal." / "Hoje vou falar de tráfego pago." / pausa longa / "Primeiro erro é não testar"
const W = (text: string, s: number, e: number): CaptionWord => ({ text, s, e });
const words = [
  W('Olá', 0.2, 0.5), W('pessoal.', 0.55, 1.0),
  W('Hoje', 1.2, 1.4), W('vou', 1.45, 1.6), W('falar', 1.65, 1.9), W('de', 1.95, 2.0), W('tráfego', 2.05, 2.5), W('pago.', 2.55, 2.9),
  W('Primeiro', 4.0, 4.4), W('erro', 4.45, 4.7), W('é', 4.75, 4.8), W('não', 4.85, 5.0), W('testar', 5.05, 5.5),
];

test('frases: quebra em pontuação final e em pausas longas', () => {
  const s = splitSentences(words);
  assert.equal(s.length, 3);
  assert.equal(s[1].text, 'Hoje vou falar de tráfego pago.');
  assert.equal(s[2].s, 4.0);
});

test('limites do corte não invadem a frase vizinha', () => {
  const s = splitSentences(words);
  const r = sentenceRange(s, 1, 1, 10);
  assert.ok(r.in >= s[0].e && r.in <= s[1].s);
  assert.ok(r.out >= s[1].e && r.out <= s[2].s);
});

test('escolhas da IA: sem sobreposição e dentro da duração', () => {
  const s = splitSentences(words);
  const picks = sanitizePicks(
    [
      { from: 0, to: 2, title: 'a', hook: 'h', why: '' },
      { from: 1, to: 1, title: 'sobrepõe', hook: 'h', why: '' },
      { from: 9, to: 12, title: 'fora', hook: 'h', why: '' },
    ],
    s, 1, 3,
  );
  assert.equal(picks[0].to, 1); // tirou a última frase para caber em 3 s
  assert.ok(!picks.some((p) => p.title === 'sobrepõe'));
});

test('ritmo: perfil por cortes e aplicação nas pausas entre palavras', () => {
  const p = rhythmFromCuts(10, [2, 4, 7]);
  assert.equal(p.shots, 4);
  assert.equal(p.medianShot, 2.5);
  assert.equal(p.cutsPerMinute, 18);
  const tl = emptyTimeline('9:16');
  tl.clips = [{ id: 'c', assetId: 'v', in: 0, out: 5.6, speed: 1, volume: 1, fit: 'cover', focusX: 0.5, focusY: 0.5 }];
  const r = applyRhythm(tl, { v: words }, 1.5);
  assert.ok(r.changes >= 2);
  const placed = layoutClips(r.timeline.clips);
  // nenhum corte no meio de uma palavra
  for (const c of placed.slice(1)) assert.ok(!words.some((w) => c.clip.in > w.s && c.clip.in < w.e), `corte em ${c.clip.in}`);
  assert.equal(r.timeline.clips[1].zoom?.from, 1.12);
  assert.equal(projectRhythm(r.timeline).shots, r.timeline.clips.length);
});
