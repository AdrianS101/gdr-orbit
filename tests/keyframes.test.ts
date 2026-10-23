import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addKeyframe, audioClipGain, kfExpr, opacityCommands, setAt, transformAt } from '../shared/keyframes.ts';
import { emptyTimeline, rippleDelete } from '../shared/timeline.ts';
import { applyAction } from '../shared/edit-actions.ts';
import type { Asset, Keyframe, LayerClip, Transform } from '../shared/types.ts';

const base: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 };
const kfs: Keyframe[] = [
  { t: 0, x: 0.2, y: 0.3, scale: 0.5, rotation: -10, opacity: 0 },
  { t: 1, x: 0.8, y: 0.3, scale: 1.5, rotation: 20, opacity: 1, ease: 'smooth' },
  { t: 3, x: 0.5, y: 0.9, scale: 1, rotation: 0, opacity: 0.5 },
];

/** Avalia a expressão gerada para o FFmpeg (if/lt/clip) em JavaScript. */
function evalFf(expr: string, t: number): number {
  const js = expr.replace(/\\,/g, ',').replace(/\bif\(/g, 'IF(');
  return new Function('t', 'IF', 'lt', 'clip', `return ${js};`)(t, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0), (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)));
}

test('quadros-chave: prévia (transformAt) e exportação (expressão FFmpeg) dão o mesmo valor', () => {
  const t0 = 2.5;
  for (const p of ['x', 'y', 'scale', 'rotation'] as const) {
    const e = kfExpr(base, kfs, p, t0);
    for (let lt = -0.5; lt <= 4; lt += 0.137) {
      assert.ok(Math.abs(evalFf(e, t0 + lt) - transformAt(base, kfs, lt)[p]) < 1e-4, `${p} em ${lt}`);
    }
  }
  assert.equal(transformAt(base, kfs, 0.5).x, 0.5); // suave no meio ainda é o ponto médio
  assert.equal(transformAt(base, kfs, 99).y, 0.9);
  assert.equal(kfExpr(base, [], 'x', 0), '0.5');
});

test('quadros-chave: editar sem quadros muda o valor fixo; com quadros cria/atualiza no cursor', () => {
  const l = { ...base, keyframes: [] as Keyframe[] } as LayerClip;
  assert.equal(setAt(l, l, 1, 2, { x: 0.1 }).x, 0.1);
  const one = addKeyframe(l, l, 1, 1);
  const two = setAt(one, one, 1, 3, { x: 0.9 });
  assert.equal(two.keyframes!.length, 2);
  assert.equal(transformAt(two, two.keyframes, 2).x, 0.9);
  assert.equal(transformAt(two, two.keyframes, 0).x, 0.5);
  const upd = setAt(two, two, 1, 3, { y: 0.2 });
  assert.equal(upd.keyframes!.length, 2);
});

test('opacidade animada vira comandos com tempo da timeline', () => {
  const c = opacityCommands(base, kfs, 2, 5, 'colorchannelmixer@x');
  assert.match(c, /^2 colorchannelmixer@x aa 0;/);
  assert.ok(c.includes('colorchannelmixer@x aa 1'));
});

test('faixa de áudio: fades lineares', () => {
  const a = { id: 'a', assetId: 'x', track: 1, start: 2, in: 0, out: 4, volume: 0.8, fadeIn: 1, fadeOut: 2 };
  assert.equal(audioClipGain(a, 1), 0);
  assert.ok(Math.abs(audioClipGain(a, 2.5) - 0.4) < 1e-9);
  assert.equal(audioClipGain(a, 3.5), 0.8);
  assert.ok(Math.abs(audioClipGain(a, 5) - 0.4) < 1e-9);
});

test('cortes deslocam as faixas livres e a IA cria PiP/B-roll/redução de ruído', () => {
  const tl = emptyTimeline('9:16');
  tl.clips = [{ id: 'c', assetId: 'v', in: 0, out: 20, speed: 1, volume: 1, fit: 'cover', focusX: 0.5, focusY: 0.5 }];
  tl.layers = [{ ...base, id: 'l', assetId: 'b', track: 1, start: 10, in: 0, out: 3, mode: 'free', width: 0.4, volume: 0 }];
  tl.audioClips = [{ id: 'a', assetId: 'n', track: 1, start: 12, in: 0, out: 2, volume: 1, fadeIn: 0, fadeOut: 0 }];
  const cut = rippleDelete(tl, 2, 5);
  assert.equal(cut.layers![0].start, 7);
  assert.equal(cut.audioClips![0].start, 9);
  const assets = { b: { id: 'b', kind: 'video', meta: { duration: 6 }, name: 'broll.mp4' } as unknown as Asset };
  const ctx = { transcripts: {}, assets, brand: { colors: [], logoAssetId: null } };
  const pip = applyAction(tl, { type: 'pip', assetId: 'b', start: 10.5, duration: 2 }, ctx).timeline;
  const added = pip.layers!.find((l) => l.id !== 'l')!;
  assert.equal(added.track, 2); // faixa 1 ocupada nesse instante
  assert.equal(added.keyframes!.length, 2);
  const br = applyAction(tl, { type: 'broll', assetId: 'b', start: 1 }, ctx).timeline.layers!.find((l) => l.id !== 'l')!;
  assert.equal(br.mode, 'cover');
  assert.equal(br.volume, 0);
  assert.equal(applyAction(tl, { type: 'denoise', level: 'strong' }, ctx).timeline.clips[0].denoise, 'strong');
});
