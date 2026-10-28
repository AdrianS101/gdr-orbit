// Enquadramento automático: acha a pessoa em cada trecho (detector local) e ajusta o foco do recorte "cover"
// para ela ficar no centro do vídeo vertical. O foco é o mesmo campo que a prévia e a exportação já usam.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.ts';
import type { Timeline } from '../../../shared/types.ts';

export interface PersonBox { cx: number; cy: number; w: number; h: number }

export function detectPeople(file: string, width: number, height: number, frames: { key: string; t: number }[]): Promise<Map<string, PersonBox | null>> {
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
        resolve(new Map(m.type === 'result' ? (m.items as { key: string; box: PersonBox | null }[]).map((i) => [i.key, i.box]) : []));
      } catch {
        resolve(new Map());
      }
    });
  });
}

/**
 * Converte a posição da pessoa no quadro original em foco do recorte (0..1).
 * Recorte horizontal: a janela visível tem fração `f` da largura; o foco põe o centro da pessoa no meio.
 * Recorte vertical: deixa a cabeça no terço superior.
 */
export function focusFor(box: PersonBox, srcAspect: number, outAspect: number): { focusX: number; focusY: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  let focusX = 0.5;
  let focusY = 0.5;
  if (srcAspect > outAspect) {
    const f = outAspect / srcAspect;
    focusX = f >= 0.98 ? 0.5 : clamp((box.cx - f / 2) / (1 - f));
  } else if (srcAspect < outAspect) {
    const f = srcAspect / outAspect;
    const head = box.cy - box.h * 0.25;
    focusY = f >= 0.98 ? 0.5 : clamp((head - f / 3) / (1 - f));
  }
  return { focusX: Number(focusX.toFixed(3)), focusY: Number(focusY.toFixed(3)) };
}

/** Aplica o enquadramento automático em vários projetos de uma vez (um único carregamento do detector). */
export async function autoReframe(file: string, src: { width: number; height: number }, timelines: Timeline[]): Promise<{ timelines: Timeline[]; found: number; total: number }> {
  const srcAspect = src.width / src.height;
  const frames: { key: string; t: number }[] = [];
  timelines.forEach((tl, i) => {
    const outAspect = tl.format.width / tl.format.height;
    if (Math.abs(srcAspect - outAspect) / outAspect < 0.05) return; // mesmo formato: nada a recortar
    tl.clips.forEach((c, j) => frames.push({ key: `${i}:${j}`, t: c.in + (c.out - c.in) / 2 }));
  });
  if (!frames.length) return { timelines, found: 0, total: 0 };
  const boxes = await detectPeople(file, src.width, src.height, frames);
  let found = 0;
  const out = timelines.map((tl, i) => {
    const outAspect = tl.format.width / tl.format.height;
    // Sem pessoa num trecho: usa a posição do trecho vizinho mais próximo (evita "pular" para o centro).
    let last: PersonBox | null = null;
    const clips = tl.clips.map((c, j) => {
      const b = boxes.get(`${i}:${j}`) ?? null;
      if (b) {
        found++;
        last = b;
      }
      const use = b ?? last;
      return use ? { ...c, ...focusFor(use, srcAspect, outAspect) } : c;
    });
    return { ...tl, clips };
  });
  return { timelines: out, found, total: frames.length };
}
