// Processo isolado de transcrição local (Whisper via ONNX Runtime).
// Recebe a configuração por argumento (JSON) e responde em linhas JSON no stdout:
//   {"type":"windows","count":N} | {"type":"loading"} | {"type":"window","index":i,"words":[...]} | {"type":"error","message":"..."}
// Cada janela concluída é enviada imediatamente, para o processo principal salvar o checkpoint.
import { spawn } from 'node:child_process';
import { pipeline, env } from '@huggingface/transformers';

interface Input {
  file: string;
  duration: number;
  model: string;
  language: string;
  modelsDir: string;
  ffmpeg: string;
  done: number[];
}

const input: Input = JSON.parse(process.argv[2]);
env.cacheDir = input.modelsDir;

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');

function ffmpegOut(args: string[], asText = false): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    const p = spawn(input.ffmpeg, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(asText ? err : Buffer.concat(out)) : reject(new Error('Falha ao ler o áudio: ' + err.slice(-300)))));
  });
}

/** Janelas de até ~28 s cortadas em pausas, para não partir palavras ao meio. */
async function planWindows(): Promise<{ from: number; to: number }[]> {
  const log = (await ffmpegOut(['-hide_banner', '-nostats', '-i', input.file, '-map', '0:a:0', '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], true)) as string;
  const silences: number[] = [];
  let start: number | null = null;
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== null) {
      silences.push((start + Number(e[1])) / 2);
      start = null;
    }
  }
  const windows: { from: number; to: number }[] = [];
  let from = 0;
  while (from < input.duration - 0.05) {
    if (input.duration - from <= 29) {
      windows.push({ from, to: input.duration });
      break;
    }
    const cands = silences.filter((t) => t > from + 15 && t < from + 28.5);
    const to = cands.length ? cands[cands.length - 1] : from + 28;
    windows.push({ from, to });
    from = to;
  }
  return windows;
}

const HALLUCINATIONS = /(amara\.org|legendas pela comunidade|legendado por|inscreva-se no canal|obrigad[oa] por assistir)/i;

async function main() {
  const windows = await planWindows();
  send({ type: 'windows', count: windows.length, windows });
  const pending = windows.map((w, i) => ({ ...w, i })).filter((w) => !input.done.includes(w.i));
  if (!pending.length) return;
  send({ type: 'loading' });
  const asr = await pipeline('automatic-speech-recognition', input.model, { dtype: 'q8' });
  for (const w of pending) {
    const raw = (await ffmpegOut(['-v', 'error', '-ss', String(w.from), '-t', String(w.to - w.from), '-i', input.file, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])) as Buffer;
    const audio = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    let rms = 0;
    for (let k = 0; k < audio.length; k++) rms += audio[k] * audio[k];
    rms = Math.sqrt(rms / Math.max(1, audio.length));
    let words: { text: string; s: number; e: number }[] = [];
    if (rms > 0.004) {
      const out: any = await asr(audio, { language: input.language, task: 'transcribe', return_timestamps: 'word' });
      const text = String(out.text ?? '');
      if (!HALLUCINATIONS.test(text)) {
        words = (out.chunks ?? [])
          .map((c: any) => ({ text: String(c.text).trim(), s: w.from + Number(c.timestamp?.[0] ?? 0), e: w.from + Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) }))
          .filter((x: any) => x.text && isFinite(x.s))
          .map((x: any) => ({ ...x, e: Math.max(x.e, x.s + 0.05) }));
      }
    }
    send({ type: 'window', index: w.i, words });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    send({ type: 'error', message: String(e?.message ?? e) });
    process.exit(1);
  },
);
