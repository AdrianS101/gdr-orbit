// Enquadramento automático: acha a pessoa em cada trecho (detector local) e ajusta o foco do recorte "cover"
// para ela ficar no centro do vídeo vertical. O foco é o mesmo campo que a prévia e a exportação já usam.
// Também define o ponto do zoom (zoomX/zoomY) no rosto, para o zoom dinâmico não "fugir" da pessoa.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.ts';
import type { Timeline } from '../../../shared/types.ts';

export interface PersonBox { cx: number; cy: number; w: number; h: number; score: number }

/** Quem focar: a maior pessoa (mais perto da câmera), a da esquerda, a da direita, o centro (sem detecção) ou a mais próxima de um ponto escolhido. */
export type ReframeTarget = { mode: 'largest' | 'left' | 'right' | 'center' } | { mode: 'pick'; x: number };

export function detectPeople(file: string, width: number, height: number, frames: { key: string; t: number }[]): Promise<Map<string, PersonBox[]>> {
  return new Promise((resolve) => {
    const worker = path.join(config.root, 'server', 'src', 'workers', 'detect-worker.ts');
    const arg = JSON.stringify({ frames: frames.map((f) => ({ ...f, file })), width, height, modelsDir: config.modelsDir, ffmpeg: config.ffmpeg });
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, arg], { windowsHide: true, cwd: config.root });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(new Map()));
    p.on('close', () => {
      const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      try {
        const m = JSON.parse(line ?? '{}');
        resolve(new Map(m.type === 'result' ? (m.items as { key: string; boxes: PersonBox[] }[]).map((i) => [i.key, i.boxes]) : []));
      } catch {
        resolve(new Map());
      }
    });
  });
}

/** Escolhe, entre as pessoas do quadro, a que corresponde à escolha do usuário. */
export function choosePerson(boxes: PersonBox[], target: ReframeTarget): PersonBox | null {
  if (!boxes.length || target.mode === 'center') return null;
  const by = (k: (b: PersonBox) => number) => [...boxes].sort((a, b) => k(a) - k(b))[0];
  if (target.mode === 'left') return by((b) => b.cx);
  if (target.mode === 'right') return by((b) => -b.cx);
  if (target.mode === 'pick') return by((b) => Math.abs(b.cx - target.x));
  return by((b) => -(b.w * b.h * b.score));
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const r3 = (v: number) => Number(v.toFixed(3));

/**
 * Converte a posição da pessoa no quadro original em foco do recorte (0..1) e em ponto do zoom no quadro final.
 * Recorte horizontal: a janela visível tem fração `f` da largura; o foco põe o centro da pessoa no meio.
 * Recorte vertical: deixa a cabeça no terço superior.
 */
export function focusFor(box: PersonBox, srcAspect: number, outAspect: number) {
  const faceY = box.cy - box.h * 0.32; // rosto ≈ parte de cima da caixa da pessoa
  let focusX = 0.5, focusY = 0.5, zoomX = box.cx, zoomY = faceY;
  if (srcAspect > outAspect) {
    const f = outAspect / srcAspect;
    focusX = f >= 0.98 ? 0.5 : clamp((box.cx - f / 2) / (1 - f));
    zoomX = (box.cx - focusX * (1 - f)) / f; // posição da pessoa no quadro final (centro, salvo nas bordas)
  } else if (srcAspect < outAspect) {
    const f = srcAspect / outAspect;
    focusY = f >= 0.98 ? 0.5 : clamp((faceY - f / 3) / (1 - f));
    zoomY = (faceY - focusY * (1 - f)) / f;
  }
  return { focusX: r3(focusX), focusY: r3(focusY), zoomX: r3(clamp(zoomX, 0.15, 0.85)), zoomY: r3(clamp(zoomY, 0.2, 0.7)) };
}

/** Aplica o enquadramento automático em vários projetos de uma vez (um único carregamento do detector). */
export async function autoReframe(file: string, src: { width: number; height: number }, timelines: Timeline[], target: ReframeTarget = { mode: 'largest' }): Promise<{ timelines: Timeline[]; found: number; total: number }> {
  const srcAspect = src.width / src.height;
  const needs = (tl: Timeline) => Math.abs(srcAspect - tl.format.width / tl.format.height) / (tl.format.width / tl.format.height) >= 0.05;
  if (target.mode === 'center') {
    return { timelines: timelines.map((tl) => ({ ...tl, clips: tl.clips.map((c) => ({ ...c, focusX: 0.5, focusY: 0.5, zoomX: undefined, zoomY: undefined })) })), found: 0, total: 0 };
  }
  // Dois quadros por trecho (1/3 e 2/3): uma pessoa que pisca, vira ou sai de um quadro ainda aparece no outro.
  const frames: { key: string; t: number }[] = [];
  timelines.forEach((tl, i) => {
    if (!needs(tl)) return;
    tl.clips.forEach((c, j) => {
      const d = c.out - c.in;
      frames.push({ key: `${i}:${j}:a`, t: c.in + d / 3 }, { key: `${i}:${j}:b`, t: c.in + (2 * d) / 3 });
    });
  });
  if (!frames.length) return { timelines, found: 0, total: 0 };
  const boxes = await detectPeople(file, src.width, src.height, frames);
  let found = 0, total = 0;
  const out = timelines.map((tl, i) => {
    if (!needs(tl)) return tl;
    const outAspect = tl.format.width / tl.format.height;
    const per = tl.clips.map((_, j) => {
      const picks = ['a', 'b'].map((s) => choosePerson(boxes.get(`${i}:${j}:${s}`) ?? [], target)).filter((b): b is PersonBox => !!b);
      if (!picks.length) return null;
      const avg = (k: keyof PersonBox) => picks.reduce((n, b) => n + b[k], 0) / picks.length;
      return { cx: avg('cx'), cy: avg('cy'), w: avg('w'), h: avg('h'), score: avg('score') };
    });
    // Trecho sem pessoa: usa o trecho mais próximo (antes ou depois) que tenha, em vez de voltar para o centro.
    const clips = tl.clips.map((c, j) => {
      total++;
      if (per[j]) found++;
      let use = per[j];
      for (let d = 1; !use && d < per.length; d++) use = per[j - d] ?? per[j + d] ?? null;
      return use ? { ...c, ...focusFor(use, srcAspect, outAspect) } : c;
    });
    return { ...tl, clips };
  });
  return { timelines: out, found, total };
}
