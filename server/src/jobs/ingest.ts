// Preparação de mídia importada: leitura de metadados, proxy leve para a prévia,
// forma de onda do áudio, miniaturas para a timeline e capa.
// O arquivo original é apenas lido — nunca alterado.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { db } from '../db.ts';
import { config } from '../config.ts';
import { probe, runFfmpeg } from '../lib/ffmpeg.ts';
import { assetPath } from '../lib/storage.ts';
import type { JobContext } from './queue.ts';

export const PEAKS_PER_SECOND = 100;

export async function ingestHandler(ctx: JobContext) {
  const { assetId } = ctx.payload as { assetId: string };
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as any;
  if (!a) throw new Error('Arquivo não encontrado no banco (pode ter sido excluído).');
  const src = assetPath(a.brand_id, a.id, 'original', a.ext);
  if (!fs.existsSync(src)) throw new Error('O arquivo original não está mais na pasta de armazenamento.');

  ctx.progress(0.02, 'Lendo informações do arquivo');
  const meta = await probe(src);
  const kind = a.kind as string;
  db.prepare('UPDATE assets SET meta = ? WHERE id = ?').run(JSON.stringify(meta), a.id);

  if (kind === 'image') {
    if (!meta.width) throw new Error('Não foi possível ler esta imagem. Use PNG, JPG ou WEBP.');
    db.prepare("UPDATE assets SET status = 'ready' WHERE id = ?").run(a.id);
    return { meta };
  }

  if (!meta.duration || meta.duration <= 0) throw new Error('O arquivo não tem duração válida. Ele pode estar corrompido ou incompleto.');
  const dur = meta.duration;

  if (meta.hasVideo) {
    const landscape = (meta.width ?? 1) >= (meta.height ?? 1);
    // Converte para pixels quadrados antes de reduzir (vídeos anamórficos de celular).
    const square = meta.sar && Math.abs(meta.sar - 1) > 0.01 ? "scale='trunc(iw*sar/2)*2':ih,setsar=1," : '';
    const scale = square + (landscape ? 'scale=-2:540' : 'scale=540:-2');
    const fps = Math.min(30, Math.round(meta.fps ?? 30)) || 30;
    const tmp = assetPath(a.brand_id, a.id, 'proxy') + '.part.mp4';
    // GOP curto = busca rápida na prévia ao pular entre trechos.
    await runFfmpeg(
      [
        '-i', src,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `${scale}:flags=bilinear,fps=${fps},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-g', String(fps / 2), '-keyint_min', String(fps / 2), '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
        '-movflags', '+faststart',
        tmp,
      ],
      { duration: dur, signal: ctx.signal, onProgress: (f) => ctx.progress(0.03 + f * 0.75, 'Gerando versão leve para a prévia') },
    );
    fs.renameSync(tmp, assetPath(a.brand_id, a.id, 'proxy'));
    db.prepare('UPDATE assets SET proxy = 1 WHERE id = ?').run(a.id);

    ctx.progress(0.8, 'Gerando miniaturas da timeline');
    const interval = Math.max(1, Math.ceil(dur / 240));
    const frames = Math.max(1, Math.ceil(dur / interval));
    const tileH = 90;
    const tileW = Math.max(2, Math.round(((meta.width ?? 16) / (meta.height ?? 9)) * tileH / 2) * 2);
    const cols = Math.min(frames, 20);
    const rows = Math.ceil(frames / cols);
    await runFfmpeg(
      ['-i', assetPath(a.brand_id, a.id, 'proxy'), '-vf', `fps=1/${interval},scale=${tileW}:${tileH},tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', assetPath(a.brand_id, a.id, 'filmstrip')],
      { signal: ctx.signal },
    );
    db.prepare('UPDATE assets SET filmstrip = ? WHERE id = ?').run(JSON.stringify({ interval, frames, tileW, tileH, cols }), a.id);

    await runFfmpeg(
      ['-ss', String(Math.min(1, dur / 2)), '-i', assetPath(a.brand_id, a.id, 'proxy'), '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', assetPath(a.brand_id, a.id, 'poster')],
      { signal: ctx.signal },
    );
  }

  if (meta.hasAudio) {
    ctx.progress(0.9, 'Lendo a forma de onda do áudio');
    await buildPeaks(src, assetPath(a.brand_id, a.id, 'waveform'), ctx.signal);
    db.prepare('UPDATE assets SET waveform = 1 WHERE id = ?').run(a.id);
  }

  db.prepare("UPDATE assets SET status = 'ready' WHERE id = ?").run(a.id);
  return { meta };
}

/** Picos de amplitude (0-255) a cada 10 ms, para desenhar a forma de onda. */
function buildPeaks(src: string, out: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const rate = 8000;
    const per = rate / PEAKS_PER_SECOND;
    const p = spawn(config.ffmpeg, ['-v', 'error', '-i', src, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const peaks: number[] = [];
    let count = 0;
    let max = 0;
    let carry: Buffer | null = null;
    p.stdout.on('data', (chunk: Buffer) => {
      const b = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = b.length - (b.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(b.readInt16LE(i));
        if (v > max) max = v;
        if (++count >= per) {
          peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
          count = 0;
          max = 0;
        }
      }
      carry = usable < b.length ? b.subarray(usable) : null;
    });
    const onAbort = () => p.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new Error('Cancelado.'));
      if (code !== 0) return reject(new Error('Não foi possível ler o áudio do arquivo.'));
      fs.writeFileSync(out, Buffer.from(peaks));
      resolve();
    });
  });
}
