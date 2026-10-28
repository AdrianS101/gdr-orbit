// Processo isolado de detecção de pessoas (YOLOS-tiny via ONNX, local e sem custo).
// Recebe por argumento (JSON) a lista de quadros a analisar e responde UMA linha JSON no stdout:
//   {"type":"result","items":[{"key","box":{cx,cy,w,h}|null}]} | {"type":"error","message"}
// Usado no enquadramento automático: centralizar a pessoa ao transformar vídeo horizontal em vertical.
import { spawn } from 'node:child_process';
import { env, pipeline, RawImage } from '@huggingface/transformers';

interface Input {
  frames: { key: string; file: string; t: number }[];
  width: number;
  height: number;
  modelsDir: string;
  ffmpeg: string;
}

const input: Input = JSON.parse(process.argv[2]);
env.cacheDir = input.modelsDir;
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');

const W = 384;
const H = Math.max(2, Math.round((W * input.height) / input.width / 2) * 2);

function frame(file: string, t: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(input.ffmpeg, ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    const out: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error('Falha ao ler o quadro do vídeo.'))));
  });
}

try {
  const detect = await pipeline('object-detection', 'Xenova/yolos-tiny', { dtype: 'q8' } as any);
  const items: { key: string; box: { cx: number; cy: number; w: number; h: number } | null }[] = [];
  for (const f of input.frames) {
    try {
      const buf = await frame(f.file, f.t);
      if (buf.length < W * H * 3) {
        items.push({ key: f.key, box: null });
        continue;
      }
      const img = new RawImage(new Uint8ClampedArray(buf.buffer, buf.byteOffset, W * H * 3), W, H, 3);
      const res = (await (detect as any)(img, { threshold: 0.6 })) as { label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }[];
      // A pessoa principal: maior área × confiança (quem está mais perto da câmera).
      const people = res.filter((r) => r.label === 'person').map((r) => ({ ...r, area: (r.box.xmax - r.box.xmin) * (r.box.ymax - r.box.ymin) }));
      people.sort((a, b) => b.area * b.score - a.area * a.score);
      const p = people[0];
      items.push({ key: f.key, box: p ? { cx: (p.box.xmin + p.box.xmax) / 2 / W, cy: (p.box.ymin + p.box.ymax) / 2 / H, w: (p.box.xmax - p.box.xmin) / W, h: (p.box.ymax - p.box.ymin) / H } : null });
    } catch {
      items.push({ key: f.key, box: null });
    }
  }
  send({ type: 'result', items });
} catch (e) {
  send({ type: 'error', message: (e as Error).message });
}
