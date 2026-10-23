// Testes das regras compartilhadas entre prévia e exportação.
// Rodar: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTimeline, layoutClips, splitAt, rippleDelete, timelineDuration, moveClip, duplicateClip, uid } from '../shared/timeline.ts';
import { buildCues, mapCuesToTimeline, setCueText, exportSrt, importSrt, wrapLines } from '../shared/captions.ts';
import { buildAss } from '../shared/ass.ts';
import { buildRenderArgs } from '../server/src/jobs/render-graph.ts';
import type { Timeline } from '../shared/types.ts';

function tlWith(dur = 20): Timeline {
  const tl = emptyTimeline('9:16');
  tl.clips = [{ id: 'c1', assetId: 'a1', in: 0, out: dur, speed: 1, volume: 1, fit: 'cover', focusX: 0.5, focusY: 0.5 }];
  return tl;
}

const words = Array.from({ length: 20 }, (_, i) => ({ text: `palavra${i}`, s: i, e: i + 0.6 }));

test('dividir e remover intervalo mantém a duração correta', () => {
  let tl = tlWith(20);
  tl = splitAt(tl, 8).timeline;
  assert.equal(tl.clips.length, 2);
  assert.equal(timelineDuration(tl), 20);
  tl = rippleDelete(tl, 5, 7);
  assert.ok(Math.abs(timelineDuration(tl) - 18) < 1e-9);
  const placed = layoutClips(tl.clips);
  assert.deepEqual(
    placed.map((p) => [p.clip.in, p.clip.out]),
    [[0, 5], [7, 8], [8, 20]],
  );
});

test('velocidade altera a duração do trecho', () => {
  const tl = tlWith(10);
  tl.clips[0].speed = 2;
  assert.equal(timelineDuration(tl), 5);
});

test('legendas acompanham cortes (ancoradas no original)', () => {
  let tl = tlWith(20);
  tl.captions.cues = buildCues('a1', words, { maxWordsPerCue: 1, maxCharsPerLine: 20 });
  tl = rippleDelete(tl, 2, 4); // remove palavras 2 e 3
  const shown = mapCuesToTimeline(tl).map((c) => c.words[0].text);
  assert.ok(!shown.includes('palavra2'));
  assert.ok(!shown.includes('palavra3'));
  const p4 = mapCuesToTimeline(tl).find((c) => c.words[0].text === 'palavra4')!;
  assert.ok(Math.abs(p4.start - 2) < 1e-6, 'palavra4 deve começar em 2s após o corte');
});

test('trecho duplicado repete a legenda e reordenar mantém sincronia', () => {
  let tl = tlWith(4);
  tl.captions.cues = buildCues('a1', words.slice(0, 4), { maxWordsPerCue: 1, maxCharsPerLine: 20 });
  tl = duplicateClip(tl, 'c1').timeline;
  assert.equal(mapCuesToTimeline(tl).length, 8);
  tl = splitAt(tl, 2).timeline;
  tl = moveClip(tl, tl.clips[1].id, 0);
  const first = mapCuesToTimeline(tl)[0];
  assert.equal(first.words[0].text, 'palavra2');
});

test('editar texto preserva tempos quando o número de palavras é igual', () => {
  const cue = buildCues('a1', words.slice(0, 3), { maxWordsPerCue: 3, maxCharsPerLine: 30 })[0];
  const next = setCueText(cue, 'um dois\ntrês')!;
  assert.deepEqual(next.words.map((w) => w.s), cue.words.map((w) => w.s));
  assert.deepEqual(next.breaks, [1]);
  const lines = wrapLines(next.words.map((w, index) => ({ text: w.text, index })), 30, next.breaks!);
  assert.equal(lines.length, 2);
});

test('SRT exporta e reimporta com os mesmos tempos', () => {
  const tl = tlWith(20);
  tl.captions.cues = buildCues('a1', words.slice(0, 8), { maxWordsPerCue: 2, maxCharsPerLine: 30 });
  const srt = exportSrt(tl);
  const back = importSrt(tl, srt);
  assert.equal(back.cues.length, tl.captions.cues.length);
  assert.ok(Math.abs(back.cues[0].words[0].s - tl.captions.cues[0].words[0].s) < 0.002);
});

test('ASS usa a resolução do formato e o estilo de destaque por palavra', () => {
  const tl = tlWith(20);
  tl.captions.cues = buildCues('a1', words.slice(0, 4), { maxWordsPerCue: 4, maxCharsPerLine: 40 });
  const ass = buildAss(tl);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 4, 'uma linha por palavra destacada');
  assert.match(dialogues[1], /\\c&H00007AFF&?/i);
});

test('render converte pixels não quadrados antes do enquadramento', () => {
  const tl = tlWith(5);
  const { args } = buildRenderArgs(tl, { width: 1080, height: 1920, fps: 30, quality: 'high', encoder: 'libx264' }, {
    assets: { a1: { file: 'x.mp4', meta: { duration: 5, width: 1216, height: 2160, sar: 81 / 256, hasAudio: true } } },
    assFile: null,
    fontsDir: null,
    output: 'out.mp4',
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /scale='trunc\(iw\*sar\/2\)\*2':ih,setsar=1/);
  assert.match(graph, /crop=1080:1920/);
  assert.ok(args.includes('-t'));
});

test('ids únicos', () => {
  const s = new Set(Array.from({ length: 1000 }, () => uid()));
  assert.equal(s.size, 1000);
});
