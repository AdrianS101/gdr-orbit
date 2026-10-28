// Monta o comando do FFmpeg a partir da timeline.
// Usa a mesma matemática de enquadramento, posição de logo e legendas (ASS) da prévia.
import type { AssetMeta, Keyframe, Timeline, Transform } from '../../../shared/types.ts';
import { clipDuration, even, layoutClips, overlapOf, timelineDuration } from '../../../shared/timeline.ts';
import { barHeight, clipFx, colorFfmpeg, isNeutral, speechIntervals, XFADE, zoomExpr } from '../../../shared/effects.ts';
import { denoiseFilter, isAnimated, kfExpr, layerDuration, maxScale, opacityCommands, overlayBase, sortKfs, stackedLayers } from '../../../shared/keyframes.ts';

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
    // Glitch digital: canais deslocados e ruído só durante a transição (mesma janela de glitchAt).
    const gl = (a: number, b: number) => `rgbashift=rh=-14:bh=14:enable='between(t,${f(a)},${f(b)})',noise=alls=38:allf=t:enable='between(t,${f(a)},${f(b)})',`;
    if (cfx.head?.type === 'glitch') post += gl(0, cfx.head.d);
    if (cfx.tail?.type === 'glitch') post += gl(D - cfx.tail.d, D);
    if (cfx.head && (cfx.head.type === 'fade' || cfx.head.type === 'flash')) post += `fade=t=in:st=0:d=${f(cfx.head.d)}:color=${cfx.head.type === 'flash' ? 'white' : 'black'},`;
    if (cfx.tail && (cfx.tail.type === 'fade' || cfx.tail.type === 'flash')) post += `fade=t=out:st=${f(D - cfx.tail.d)}:d=${f(cfx.tail.d)}:color=${cfx.tail.type === 'flash' ? 'white' : 'black'},`;
    // Efeitos de vídeo (mesmas fórmulas da prévia, em shared/effects.ts).
    const ef = c.effects ?? [];
    if (ef.includes('tremor')) {
      const sx = '(1.2*sin(t*23)+0.6*sin(t*37))';
      const sy = '(1.0*sin(t*29+1)+0.5*sin(t*41))';
      post += `scale=${even(W * 1.06)}:${even(H * 1.06)},crop=${W}:${H}:x='(iw-${W})*${f(fx2(c.focusX))}-${W}*${sx}/100':y='(ih-${H})*${f(fx2(c.focusY))}-${H}*${sy}/100',`;
    }
    if (ef.includes('vinheta')) post += 'vignette=angle=PI/4.2,';
    if (ef.includes('barras')) {
      const bh = even(H * barHeight(W, H));
      post += `drawbox=x=0:y=0:w=iw:h=${bh}:color=black:t=fill,drawbox=x=0:y=ih-${bh}:w=iw:h=${bh}:color=black:t=fill,`;
    }
    const tail = `${post}tpad=stop_mode=clone:stop_duration=0.2,trim=duration=${f(D)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p,settb=AVTB[v${i}]`;
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
        `[${vi}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${c.denoise ? ',' + denoiseFilter(c.denoise) : ''}${tempo ? ',' + tempo : ''},${vol},apad=whole_dur=${f(D)},atrim=duration=${f(D)},asetpts=PTS-STARTPTS[a${i}]`,
      );
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f(D)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    concatPads.push(`[v${i}][a${i}]`);
  });

  if (!placed.some((p) => overlapOf(tl.clips, p.index) > 0)) {
    filters.push(`${concatPads.join('')}concat=n=${placed.length}:v=1:a=1[vcat][acat]`);
  } else {
    // Transições cruzadas: junta um trecho por vez; xfade/acrossfade onde há sobreposição, concat no resto.
    // O offset do xfade é o início do trecho na timeline (mesmo layout da prévia).
    let v = 'v0';
    let a = 'a0';
    for (let i = 1; i < placed.length; i++) {
      const ov = overlapOf(tl.clips, i);
      const last = i === placed.length - 1;
      const vo = last ? 'vcat' : `vx${i}`;
      const ao = last ? 'acat' : `ax${i}`;
      if (ov > 0) {
        filters.push(`[${v}][v${i}]xfade=transition=${XFADE[tl.clips[i].transition!.type]}:duration=${f(ov)}:offset=${f(placed[i].start)},settb=AVTB[${vo}]`);
        filters.push(`[${a}][a${i}]acrossfade=d=${f(ov)}:c1=tri:c2=tri[${ao}]`);
      } else {
        filters.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[${vo}tmp][${ao}]`);
        filters.push(`[${vo}tmp]settb=AVTB[${vo}]`);
      }
      v = vo;
      a = ao;
    }
  }
  let vLabel = 'vcat';

  // Faixas livres (picture-in-picture/B-roll), depois logo/imagens — mesma geometria e quadros-chave da prévia.
  const extraAudio: string[] = [];
  stackedLayers(tl).forEach((l, k) => {
    const asset = inp.assets[l.assetId];
    if (!asset || !asset.meta.width || !asset.meta.height) return;
    const len = Math.min(layerDuration(l), total - l.start);
    if (len <= 0.04) return;
    const isImage = !asset.meta.duration || asset.meta.hasVideo === false || /\.(png|jpe?g|webp)$/i.test(asset.file);
    if (isImage) args.push('-loop', '1', '-t', f(len), '-i', asset.file);
    else args.push('-ss', f(l.in), '-t', f(len), '-i', asset.file);
    const li = inputIndex++;
    const sm = maxScale(l, l.keyframes);
    const square = asset.meta.sar && Math.abs(asset.meta.sar - 1) > 0.01 ? "scale='trunc(iw*sar/2)*2':ih," : '';
    const content =
      l.mode === 'cover'
        ? `scale=${even(W * sm)}:${even(H * sm)}:force_original_aspect_ratio=increase:flags=bicubic,crop=${even(W * sm)}:${even(H * sm)}`
        : `scale=${Math.max(2, even(l.width * W * sm))}:-2:flags=bicubic`;
    // O tempo do item passa a ser o tempo da timeline: as expressões dos quadros-chave usam t direto.
    const pre = `[${li}:v]setpts=PTS-STARTPTS,fps=${fps},${square}setsar=1,${content},format=rgba,setpts=PTS+${f(l.start)}/TB`;
    vLabel = placeTransformed(filters, vLabel, pre, l, l.keyframes, l.start, l.start + len, sm, `ly${k}`);
    if (!isImage && asset.meta.hasAudio && l.volume > 0) {
      const dn = l.denoise ? ',' + denoiseFilter(l.denoise) : '';
      filters.push(`[${li}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${dn},volume=${f(l.volume)},adelay=${Math.round(l.start * 1000)}:all=1[lya${k}]`);
      extraAudio.push(`[lya${k}]`);
    }
  });

  tl.overlays.forEach((o, k) => {
    const asset = inp.assets[o.assetId];
    if (!asset || !asset.meta.width || !asset.meta.height) return;
    const start = Math.max(0, o.start);
    const end = Math.min(total, o.end);
    if (end <= start) return;
    args.push('-loop', '1', '-t', f(total), '-i', asset.file);
    const li = inputIndex++;
    const base = overlayBase(o);
    const sm = maxScale(base, o.keyframes);
    const pre = `[${li}:v]format=rgba,scale=${Math.max(2, even(o.width * W * sm))}:-2:flags=lanczos`;
    vLabel = placeTransformed(filters, vLabel, pre, base, o.keyframes, start, end, sm, `ov${k}`);
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
    extraAudio.unshift('[mus]');
  }
  // Faixas de áudio (narração, efeitos): fades lineares iguais aos da prévia.
  (tl.audioClips ?? []).forEach((a, k) => {
    const asset = inp.assets[a.assetId];
    const len = Math.min(layerDuration(a), total - a.start);
    if (!asset || len <= 0.04 || a.volume <= 0) return;
    args.push('-ss', f(a.in), '-t', f(len), '-i', asset.file);
    const ai = inputIndex++;
    let chain = `[${ai}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${a.denoise ? ',' + denoiseFilter(a.denoise) : ''},volume=${f(a.volume)}`;
    if (a.fadeIn > 0) chain += `,afade=t=in:st=0:d=${f(Math.min(a.fadeIn, len))}`;
    if (a.fadeOut > 0) chain += `,afade=t=out:st=${f(Math.max(0, len - a.fadeOut))}:d=${f(Math.min(a.fadeOut, len))}`;
    filters.push(`${chain},adelay=${Math.round(a.start * 1000)}:all=1[aux${k}]`);
    extraAudio.push(`[aux${k}]`);
  });
  if (extraAudio.length) {
    filters.push(`[acat]${extraAudio.join('')}amix=inputs=${extraAudio.length + 1}:duration=first:normalize=0[amix]`);
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

/**
 * Aplica rotação, opacidade e escala (fixas ou por quadros-chave) e sobrepõe com o centro em (x, y).
 * O conteúdo chega no tamanho da maior escala usada (sm), para nunca ampliar uma imagem já reduzida.
 */
function placeTransformed(filters: string[], under: string, pre: string, base: Transform, kfs: Keyframe[] | undefined, start: number, end: number, sm: number, id: string): string {
  const k = sortKfs(kfs);
  const first = k.length ? k[0] : base;
  let chain = pre;
  if (isAnimated(k, 'rotation') || Math.abs(first.rotation) > 0.01) {
    // Margem transparente até a diagonal antes de girar: com ângulo animado o rotate recorta no retângulo original.
    chain += `,pad=w='ceil(hypot(iw,ih)/2)*2':h='ceil(hypot(iw,ih)/2)*2':x='(ow-iw)/2':y='(oh-ih)/2':color=black@0`;
    chain += `,rotate=a='(${kfExpr(base, k, 'rotation', start)})*PI/180':c=none`;
  }
  if (isAnimated(k, 'opacity')) {
    chain += `,sendcmd=c='${opacityCommands(base, k, start, end, `colorchannelmixer@${id}`)}',colorchannelmixer@${id}=aa=${f(Math.min(1, Math.max(0, first.opacity)))}`;
  } else if (first.opacity < 0.999) {
    chain += `,colorchannelmixer=aa=${f(Math.max(0, first.opacity))}`;
  }
  if (isAnimated(k, 'scale')) chain += `,scale=w='max(2,trunc(iw*(${kfExpr(base, k, 'scale', start)})/${f(sm)}/2)*2)':h=-2:eval=frame`;
  else if (Math.abs(first.scale - sm) > 1e-4) chain += `,scale=w='max(2,trunc(iw*${f(first.scale / sm)}/2)*2)':h=-2`;
  filters.push(`${chain}[${id}]`);
  const x = kfExpr(base, k, 'x', start);
  const y = kfExpr(base, k, 'y', start);
  filters.push(`[${under}][${id}]overlay=x='(${x})*W-w/2':y='(${y})*H-h/2':eval=frame:eof_action=pass:format=auto:enable='between(t,${f(start)},${f(end)})'[${id}o]`);
  return `${id}o`;
}
