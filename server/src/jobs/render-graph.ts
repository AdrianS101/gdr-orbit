// Monta o comando do FFmpeg a partir da timeline.
// Usa a mesma matemática de enquadramento, posição de logo e legendas (ASS) da prévia.
import type { AssetMeta, Timeline } from '../../../shared/types.ts';
import { clipDuration, even, layoutClips, timelineDuration } from '../../../shared/timeline.ts';
import { clipFx, colorFfmpeg, isNeutral, speechIntervals, zoomExpr } from '../../../shared/effects.ts';

const fx2 = (v: number) => Math.min(1, Math.max(0, v));

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  quality: 'standard' | 'high' | 'max';
  encoder: 'libx264' | 'h264_nvenc' | 'h264_qsv';
}

export interface RenderInputs {
  /** Caminho do original e metadados por assetId. */
  assets: Record<string, { file: string; meta: AssetMeta }>;
  /** Nome do arquivo ASS relativo ao diretório de trabalho (ou null sem legendas). */
  assFile: string | null;
  fontsDir: string | null;
  output: string;
}

// Qualidade x tempo: "standard" prioriza velocidade (rascunhos), "max" prioriza qualidade final.
const X264: Record<RenderSettings['quality'], { preset: string; crf: number }> = {
  standard: { preset: 'veryfast', crf: 22 },
  high: { preset: 'faster', crf: 20 },
  max: { preset: 'slow', crf: 18 },
};
const HW_Q: Record<RenderSettings['quality'], number> = { standard: 26, high: 22, max: 19 };

function f(n: number) {
  return Number(n.toFixed(4)).toString();
}

function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  while (s > 100) {
    parts.push('atempo=100');
    s /= 100;
  }
  if (Math.abs(s - 1) > 1e-4) parts.push(`atempo=${f(s)}`);
  return parts.join(',');
}

export function buildRenderArgs(tl: Timeline, st: RenderSettings, inp: RenderInputs): { args: string[]; duration: number } {
  const W = even(st.width);
  const H = even(st.height);
  const fps = st.fps;
  const placed = layoutClips(tl.clips);
  if (!placed.length) throw new Error('A timeline está vazia. Adicione ao menos um vídeo antes de exportar.');
  const total = timelineDuration(tl);

  const args: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;
  const concatPads: string[] = [];

  placed.forEach((p, i) => {
    const c = p.clip;
    const asset = inp.assets[c.assetId];
    if (!asset) throw new Error(`Um trecho usa um arquivo que não existe mais (${c.assetId}). Remova o trecho ou reimporte o arquivo.`);
    const D = clipDuration(c);
    const srcLen = c.out - c.in;
    // Busca por entrada: rápida e precisa (o FFmpeg decodifica a partir do keyframe anterior).
    args.push('-ss', f(c.in), '-t', f(srcLen + 0.05), '-i', asset.file);
    const vi = inputIndex++;

    const fx = Math.min(1, Math.max(0, c.focusX));
    const fy = Math.min(1, Math.max(0, c.focusY));
    // Pixels não quadrados são convertidos primeiro, para o enquadramento bater com a prévia.
    const square = asset.meta.sar && Math.abs(asset.meta.sar - 1) > 0.01 ? "scale='trunc(iw*sar/2)*2':ih," : '';
    const base = `[${vi}:v:0]setpts=(PTS-STARTPTS)/${f(c.speed)},fps=${fps},${square}setsar=1`;
    const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}:(iw-${W})*${f(fx)}:(ih-${H})*${f(fy)}`;
    const contain = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`;
    // Efeitos do trecho: zoom animado, cor e transições (mesmas fórmulas da prévia, em shared/effects.ts).
    const cfx = clipFx(tl.clips, i);
    let post = '';
    const zx = zoomExpr(c, cfx, 'it');
    if (zx) post += `zoompan=z='${zx}':x='(iw-iw/zoom)*${f(fx2(c.focusX))}':y='(ih-ih/zoom)*${f(fx2(c.focusY))}':d=1:s=${W}x${H}:fps=${fps},`;
    if (!isNeutral(c.color)) post += `${colorFfmpeg(c.color!)},`;
    if (cfx.head && cfx.head.type !== 'zoom') post += `fade=t=in:st=0:d=${f(cfx.head.d)}:color=${cfx.head.type === 'flash' ? 'white' : 'black'},`;
    if (cfx.tail && cfx.tail.type !== 'zoom') post += `fade=t=out:st=${f(D - cfx.tail.d)}:d=${f(cfx.tail.d)}:color=${cfx.tail.type === 'flash' ? 'white' : 'black'},`;
    const tail = `${post}tpad=stop_mode=clone:stop_duration=0.2,trim=duration=${f(D)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${i}]`;
    if (c.fit === 'cover') {
      filters.push(`${base},${cover},${tail}`);
    } else if (c.fit === 'contain') {
      filters.push(`${base},${contain},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,${tail}`);
    } else {
      const blur = Math.max(8, Math.round(Math.min(W, H) / 40));
      filters.push(`${base},split[b${i}][f${i}]`);
      filters.push(`[b${i}]${cover},boxblur=${blur}:2,eq=brightness=-0.06[bg${i}]`);
      filters.push(`[f${i}]${contain}[fg${i}]`);
      filters.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,${tail}`);
    }

    const vol = `volume=${f(c.volume)}`;
    const tempo = atempoChain(c.speed);
    if (asset.meta.hasAudio) {
      filters.push(
        `[${vi}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${tempo ? ',' + tempo : ''},${vol},apad=whole_dur=${f(D)},atrim=duration=${f(D)},asetpts=PTS-STARTPTS[a${i}]`,
      );
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f(D)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    concatPads.push(`[v${i}][a${i}]`);
  });

  filters.push(`${concatPads.join('')}concat=n=${placed.length}:v=1:a=1[vcat][acat]`);
  let vLabel = 'vcat';

  // Sobreposições (logo e imagens) — mesma geometria da prévia.
  tl.overlays.forEach((o, k) => {
    const asset = inp.assets[o.assetId];
    if (!asset || !asset.meta.width || !asset.meta.height) return;
    const start = Math.max(0, o.start);
    const end = Math.min(total, o.end);
    if (end <= start) return;
    args.push('-loop', '1', '-t', f(total), '-i', asset.file);
    const li = inputIndex++;
    const lw = Math.max(2, even(o.width * W));
    const lh = Math.max(2, even((lw * asset.meta.height) / asset.meta.width));
    const x = Math.round(o.x * W - lw / 2);
    const y = Math.round(o.y * H - lh / 2);
    filters.push(`[${li}:v]format=rgba,scale=${lw}:${lh}:flags=lanczos,colorchannelmixer=aa=${f(o.opacity)}[ov${k}]`);
    filters.push(`[${vLabel}][ov${k}]overlay=x=${x}:y=${y}:enable='between(t,${f(start)},${f(end)})':format=auto[vo${k}]`);
    vLabel = `vo${k}`;
  });

  if (inp.assFile) {
    const fontsOpt = inp.fontsDir ? `:fontsdir=${inp.fontsDir}` : '';
    filters.push(`[${vLabel}]ass=${inp.assFile}${fontsOpt}[vsub]`);
    vLabel = 'vsub';
  }
  filters.push(`[${vLabel}]format=${st.encoder === 'h264_qsv' ? 'nv12' : 'yuv420p'}[vout]`);

  // Música de fundo com ducking determinístico (intervalos de fala da transcrição — iguais aos da prévia).
  let aLabel = 'acat';
  const m = tl.music;
  const mAsset = m ? inp.assets[m.assetId] : null;
  if (m && mAsset) {
    args.push('-stream_loop', '-1', '-ss', f(m.offset), '-i', mAsset.file);
    const mi = inputIndex++;
    const iv = m.ducking ? speechIntervals(tl) : [];
    const duck = iv.length ? `*(1-${f(1 - m.duckLevel)}*(${iv.map(([a, b]) => `between(t\\,${a}\\,${b})`).join('+')}))` : '';
    let chain = `[${mi}:a:0]atrim=duration=${f(total)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume='${f(m.volume)}${duck}':eval=frame`;
    if (m.fadeIn > 0) chain += `,afade=t=in:st=0:d=${f(m.fadeIn)}`;
    if (m.fadeOut > 0) chain += `,afade=t=out:st=${f(Math.max(0, total - m.fadeOut))}:d=${f(m.fadeOut)}`;
    filters.push(`${chain}[mus]`);
    filters.push(`[acat][mus]amix=inputs=2:duration=first:normalize=0[amix]`);
    aLabel = 'amix';
  }
  if (tl.audio.normalize) filters.push(`[${aLabel}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
  else filters.push(`[${aLabel}]anull[aout]`);

  args.push('-filter_complex', filters.join(';\n'));
  args.push('-map', '[vout]', '-map', '[aout]');
  if (st.encoder === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(HW_Q[st.quality]), '-b:v', '0', '-pix_fmt', 'yuv420p');
  } else if (st.encoder === 'h264_qsv') {
    args.push('-c:v', 'h264_qsv', '-preset', st.quality === 'max' ? 'slower' : 'medium', '-global_quality', String(HW_Q[st.quality]), '-look_ahead', '0');
  } else {
    args.push('-c:v', 'libx264', '-preset', X264[st.quality].preset, '-crf', String(X264[st.quality].crf), '-pix_fmt', 'yuv420p');
  }
  args.push('-profile:v', 'high', '-r', String(fps));
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  args.push('-t', f(total), '-movflags', '+faststart', inp.output);
  return { args, duration: total };
}
