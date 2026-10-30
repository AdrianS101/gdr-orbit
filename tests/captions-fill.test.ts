// Completar legendas: estender um trecho cria legenda só para a parte nova e mantém as correções existentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCues, fillMissingCues } from '../shared/captions.ts';
import { emptyTimeline } from '../shared/timeline.ts';
import type { CaptionWord } from '../shared/types.ts';

const words: CaptionWord[] = Array.from({ length: 20 }, (_, i) => ({ text: `p${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));

test('estender o trecho legenda só a parte nova', () => {
  const tl = emptyTimeline('9:16');
  tl.clips = [{ id: 'c1', assetId: 'a', in: 0, out: 5, speed: 1, volume: 1, fit: 'cover', focusX: 0.5, focusY: 0.5 }];
  tl.captions.cues = buildCues('a', words, tl.captions.style, [{ from: 0, to: 5 }]);
  tl.captions.cues[0] = { ...tl.captions.cues[0], words: tl.captions.cues[0].words.map((w, i) => (i === 0 ? { ...w, text: 'CORRIGIDO' } : w)) };
  const before = tl.captions.cues.length;
  assert.equal(fillMissingCues(tl, { a: words }).added, 0);
  tl.clips[0].out = 10; // estendeu 5 s
  const r = fillMissingCues(tl, { a: words });
  assert.ok(r.added > 0);
  assert.equal(r.words, 10);
  assert.equal(r.timeline.captions.cues[0].words[0].text, 'CORRIGIDO');
  assert.equal(r.timeline.captions.cues.length, before + r.added);
  const all = r.timeline.captions.cues.flatMap((q) => q.words.map((w) => w.s));
  assert.deepEqual(all, [...all].sort((x, y) => x - y));
  assert.equal(new Set(all).size, all.length); // nenhuma palavra repetida
});
