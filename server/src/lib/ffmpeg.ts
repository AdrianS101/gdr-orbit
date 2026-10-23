import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.ts';
import type { AssetMeta } from '../../../shared/types.ts';

export interface RunOptions {
  cwd?: string;
  /** Duração total esperada (s) para calcular o progresso. */
  duration?: number;
  onProgress?: (fraction: number, info: { outTime: number; speed: string }) => void;
  signal?: AbortSignal;
}

export class FfmpegError extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

/** Executa o FFmpeg com acompanhamento de progresso e cancelamento. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    const p: ChildProcess = spawn(config.ffmpeg, full, { cwd: opts.cwd, windowsHide: true });
    let stderr = '';
    let buf = '';
    let outTime = 0;
    p.stderr!.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    p.stdout!.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      let speed = '';
      for (const l of lines) {
        const [k, v] = l.split('=');
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const n = Number(v);
          if (isFinite(n)) outTime = n / 1e6;
        }
        if (k === 'speed') speed = v?.trim() ?? '';
        if (k === 'progress' && opts.duration && opts.onProgress) {
          opts.onProgress(Math.min(1, Math.max(0, outTime / opts.duration)), { outTime, speed });
        }
      }
    });
    const onAbort = () => p.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => reject(new FfmpegError(`Não foi possível iniciar o FFmpeg (${e.message}).`, '')));
    p.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new FfmpegError('Cancelado.', stderr));
      if (code === 0) resolve();
      else reject(new FfmpegError(summarizeFfmpegError(stderr), stderr));
    });
  });
}

/** Extrai a linha de erro mais útil do log do FFmpeg. */
export function summarizeFfmpegError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const important = lines.filter((l) => /error|invalid|no such|not found|failed|unable|cannot|could not/i.test(l));
  return (important.slice(-3).join(' | ') || lines.slice(-2).join(' | ') || 'Falha desconhecida no FFmpeg.').slice(0, 600);
}

export function runCapture(bin: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d.toString()));
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelado.'));
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new FfmpegError(summarizeFfmpegError(err), err));
    });
  });
}

export async function probe(file: string): Promise<AssetMeta & { formatName?: string }> {
  const out = await runCapture(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out.toString());
  const v = j.streams?.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams?.find((s: any) => s.codec_type === 'audio');
  const rate = (r?: string) => {
    if (!r) return undefined;
    const [n, d] = r.split('/').map(Number);
    return d ? Math.round((n / d) * 1000) / 1000 : n;
  };
  let rotation = 0;
  const sd = v?.side_data_list?.find((x: any) => x.rotation !== undefined);
  if (sd) rotation = Number(sd.rotation) || 0;
  else if (v?.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
  // Dimensões de exibição: considera pixels não quadrados (vídeos anamórficos de celular) e rotação.
  let sar = 1;
  const sarStr = v?.sample_aspect_ratio as string | undefined;
  if (sarStr && /^\d+:\d+$/.test(sarStr) && sarStr !== '0:1') {
    const [a, b] = sarStr.split(':').map(Number);
    if (a > 0 && b > 0) sar = a / b;
  }
  let width = v?.width ? Math.round((v.width * sar) / 2) * 2 : undefined;
  let height = v?.height;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    duration: j.format?.duration ? Number(j.format.duration) : undefined,
    width,
    height,
    fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate),
    hasVideo: !!v,
    hasAudio: !!a,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    rotation,
    sar,
    formatName: j.format?.format_name,
  };
}

let encoderCache: Promise<string[]> | null = null;

/** Encoders H.264 que realmente funcionam nesta máquina (testados com uma codificação curta). */
export function availableEncoders(): Promise<string[]> {
  encoderCache ??= (async () => {
    const ok = ['libx264'];
    for (const enc of ['h264_qsv', 'h264_nvenc']) {
      try {
        const extra = enc === 'h264_qsv' ? ['-vf', 'format=nv12'] : [];
        await runCapture(config.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.3', ...extra, '-c:v', enc, '-f', 'null', '-']);
        ok.push(enc);
      } catch {
        /* encoder indisponível neste hardware */
      }
    }
    return ok;
  })();
  return encoderCache;
}
