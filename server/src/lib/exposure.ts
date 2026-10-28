// Correção automática de luz: mede o brilho real do trecho (FFmpeg signalstats) e calcula o ajuste
// de brilho/contraste para chegar num ponto agradável — nem escuro nem estourado.
// O ajuste entra no ColorAdjust do trecho, então a prévia (SVG) e a exportação (lutrgb) aplicam a mesma conta.
import { spawn } from 'node:child_process';
import { config } from '../config.ts';

export interface Exposure {
  avg: number; // luminância média 0..255
  low: number; // 10º percentil aproximado
  high: number; // 90º percentil aproximado
}

export function measureExposure(file: string, from: number, dur: number): Promise<Exposure | null> {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-ss', String(Math.max(0, from)), '-t', String(Math.max(1, Math.min(dur, 120))), '-i', file, '-an', '-vf', 'fps=1,scale=320:-2,signalstats,metadata=print:file=-', '-f', 'null', '-'];
    const p = spawn(config.ffmpeg, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const pick = (k: string) => [...out.matchAll(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
      const avg = pick('YAVG'), low = pick('YLOW'), high = pick('YHIGH');
      if (!avg.length) return resolve(null);
      const mean = (a: number[]) => a.reduce((n, x) => n + x, 0) / a.length;
      resolve({ avg: mean(avg), low: mean(low.length ? low : avg), high: mean(high.length ? high : avg) });
    });
  });
}

/**
 * Ajuste guiado pelas partes claras (rosto/assunto), não pela média: fundo escuro de estúdio é estilo, não erro.
 * Leva o 90º percentil a ~195/255, limitado a ±20%, e só reforça mais se a imagem inteira estiver escura.
 */
export function exposureCorrection(e: Exposure): { brightness: number; contrast: number } {
  let brightness = 195 / Math.max(40, e.high);
  if (e.avg < 45 && e.high < 130) brightness *= 1.1; // vídeo realmente subexposto
  brightness = Math.min(1.25, Math.max(0.85, brightness));
  if (Math.abs(brightness - 1) < 0.03) brightness = 1;
  // Imagem "lavada" (pouco contraste): realça um pouco.
  const range = e.high - e.low;
  const contrast = range < 120 ? 1.12 : range < 160 ? 1.06 : 1;
  return { brightness: Number(brightness.toFixed(3)), contrast };
}
