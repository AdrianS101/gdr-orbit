import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { db, now } from '../db.ts';
import { config } from '../config.ts';
import { assetPath } from '../lib/storage.ts';
import type { JobContext } from './queue.ts';

export const TRANSCRIBE_MODELS: Record<string, { label: string; hint: string }> = {
  'Xenova/whisper-small': { label: 'Precisa (recomendado)', hint: 'Melhor qualidade em português. ~1x a duração do vídeo neste computador.' },
  'Xenova/whisper-base': { label: 'Rápida', hint: 'Cerca de 3x mais rápida, com mais erros de palavras.' },
};

interface Checkpoint {
  windows?: { from: number; to: number }[];
  results: Record<number, { text: string; s: number; e: number }[]>;
}

export async function transcribeHandler(ctx: JobContext) {
  const { assetId, model = 'Xenova/whisper-small', language = 'portuguese' } = ctx.payload as { assetId: string; model?: string; language?: string };
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as any;
  if (!a) throw new Error('Arquivo não encontrado.');
  const meta = JSON.parse(a.meta);
  if (!meta.hasAudio) throw new Error('Este arquivo não tem áudio para transcrever.');
  const src = assetPath(a.brand_id, a.id, 'original', a.ext);
  if (!fs.existsSync(src)) throw new Error('O arquivo original não foi encontrado no armazenamento.');

  const cp: Checkpoint = ctx.checkpoint<Checkpoint>() ?? { results: {} };
  const done = Object.keys(cp.results).map(Number);
  if (done.length) ctx.progress(0.05, `Retomando transcrição (${done.length} parte(s) já prontas)`);
  else ctx.progress(0.01, 'Analisando o áudio');

  const worker = path.join(import.meta.dirname, '..', 'workers', 'transcribe-worker.ts');
  const arg = JSON.stringify({ file: src, duration: meta.duration, model, language, modelsDir: config.modelsDir, ffmpeg: config.ffmpeg, done });

  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, arg], { windowsHide: true, cwd: config.root });
    let buf = '';
    let err = '';
    let total = 0;
    const onAbort = () => p.kill('SIGKILL');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(l);
        } catch {
          continue;
        }
        if (m.type === 'windows') {
          total = m.count;
          cp.windows = m.windows;
          ctx.checkpoint(cp);
        } else if (m.type === 'loading') {
          ctx.progress(0.04, 'Carregando o modelo de transcrição (na primeira vez ele é baixado, ~250 MB)');
        } else if (m.type === 'window') {
          cp.results[m.index] = m.words;
          ctx.checkpoint(cp);
          const n = Object.keys(cp.results).length;
          ctx.progress(0.05 + 0.93 * (n / Math.max(1, total)), `Transcrevendo: parte ${n} de ${total}`);
        } else if (m.type === 'error') {
          err = m.message;
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort);
      if (ctx.signal.aborted) return reject(new Error('Cancelado.'));
      if (code === 0) resolve();
      else {
        const hint = /fetch|network|ENOTFOUND|ECONN/i.test(err) ? ' Verifique a conexão com a internet: o modelo precisa ser baixado na primeira utilização.' : '';
        reject(new Error(`A transcrição falhou: ${err.trim().split('\n').slice(-1)[0] || 'erro desconhecido'}.${hint} O progresso salvo será aproveitado ao tentar novamente.`));
      }
    });
  });

  const words = Object.keys(cp.results)
    .map(Number)
    .sort((x, y) => x - y)
    .flatMap((k) => cp.results[k]);
  const text = words.map((w) => w.text).join(' ');
  db.prepare(
    `INSERT INTO transcripts (asset_id, language, model, text, words, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET language = excluded.language, model = excluded.model, text = excluded.text, words = excluded.words, created_at = excluded.created_at`,
  ).run(assetId, language, model, text, JSON.stringify(words), now());
  return { words: words.length, chars: text.length };
}
