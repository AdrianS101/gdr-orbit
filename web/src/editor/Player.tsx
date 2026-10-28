// Prévia do projeto.
// - Dois elementos <video> alternados: enquanto um toca, o outro já espera no próximo trecho.
// - Legendas desenhadas pela libass (WASM/JASSUB) a partir do MESMO arquivo ASS da exportação.
// - Enquadramento (cover/contain/blur), foco e posição do logo usam a mesma matemática do FFmpeg.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import JASSUB from 'jassub';
import { useEditor } from './store.ts';
import { media } from '../lib/api.ts';
import { buildAss } from '../../../shared/ass.ts';
import { barHeight, clipFx, colorSvg, crossAt, fadeAt, glitchAt, shakeAt, isNeutral, musicGainAt, speechIntervals, zoomAt } from '../../../shared/effects.ts';
import { clipAt, layoutClips, overlapOf, sourceTimeAt, timelineDuration, SAFE_AREAS_VERTICAL, type PlacedClip } from '../../../shared/timeline.ts';
import { audioClipGain, layerDuration, overlayBase, setAt, stackedLayers, transformAt } from '../../../shared/keyframes.ts';
import type { Asset, AudioClip, LayerClip, Timeline, VideoClip } from '../../../shared/types.ts';

const END_EPS = 1 / 45;

function applyFit(v: HTMLVideoElement, c: VideoClip) {
  v.style.objectFit = c.fit === 'cover' ? 'cover' : 'contain';
  v.style.objectPosition = c.fit === 'cover' ? `${c.focusX * 100}% ${c.focusY * 100}%` : '50% 50%';
}

export function Player({ showSafe }: { showSafe: boolean }) {
  const timeline = useEditor((s) => s.timeline)!;
  const project = useEditor((s) => s.project)!;
  const assets = useEditor((s) => s.assets);
  const playing = useEditor((s) => s.playing);
  const selection = useEditor((s) => s.selection);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const v0 = useRef<HTMLVideoElement>(null);
  const v1 = useRef<HTMLVideoElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [time, setLocalTime] = useState(0);
  const [captionError, setCaptionError] = useState('');

  const W = timeline.format.width;
  const H = timeline.format.height;
  const placed = useMemo(() => layoutClips(timeline.clips), [timeline.clips]);
  const total = useMemo(() => timelineDuration(timeline), [timeline]);

  // ---- tamanho do palco (mantém a proporção do formato) ----
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const k = Math.min((r.width - 16) / W, (r.height - 16) / H);
      setSize({ w: Math.max(10, Math.floor(W * k)), h: Math.max(10, Math.floor(H * k)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // ---- motor de reprodução ----
  const eng = useRef({ active: 0, clipId: '' as string, incoming: '' as string, raf: 0, audio: null as AudioContext | null, gains: [] as GainNode[], placed: [] as PlacedClip[], tl: timeline });
  eng.current.placed = placed;
  eng.current.tl = timeline;

  const videos = () => [v0.current!, v1.current!];

  const setGain = (idx: number, vol: number) => {
    const e = eng.current;
    if (e.gains[idx]) e.gains[idx].gain.value = vol;
    else videos()[idx].volume = Math.min(1, vol);
  };

  const ensureAudio = () => {
    const e = eng.current;
    if (e.audio) return;
    try {
      e.audio = new AudioContext();
      e.gains = videos().map((v) => {
        const src = e.audio!.createMediaElementSource(v);
        const g = e.audio!.createGain();
        src.connect(g).connect(e.audio!.destination);
        return g;
      });
    } catch {
      /* sem Web Audio: usa volume do elemento (até 100%) */
    }
  };

  const loadInto = (v: HTMLVideoElement, p: PlacedClip, at: number) => {
    const url = media.proxy(p.clip.assetId);
    if (!v.src.endsWith(url)) v.src = url;
    const target = Math.max(0, at);
    if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target;
    v.playbackRate = p.clip.speed;
    applyFit(v, p.clip);
  };

  const show = (idx: number) => {
    const [a, b] = videos();
    a.style.opacity = idx === 0 ? '1' : '0';
    b.style.opacity = idx === 1 ? '1' : '0';
  };

  /** Posiciona a prévia no instante t (sem tocar). */
  const seek = (t: number) => {
    const e = eng.current;
    const pl = e.placed;
    if (!pl.length) return;
    const p = clipAt(pl, Math.min(t, total - 0.001)) ?? pl[pl.length - 1];
    const v = videos()[e.active];
    loadInto(v, p, sourceTimeAt(p, Math.min(t, p.end - 0.001)));
    setGain(e.active, p.clip.volume);
    e.clipId = p.clip.id;
    show(e.active);
    const next = pl[p.index + 1];
    // Na sobreposição de uma transição cruzada, o próximo trecho já aparece junto.
    const inOverlap = next && overlapOf(e.tl.clips, next.index) > 0 && t >= next.start;
    if (next) loadInto(videos()[1 - e.active], next, inOverlap ? sourceTimeAt(next, t) : next.clip.in);
    e.incoming = inOverlap ? next.clip.id : '';
  };

  // Atualiza a prévia quando o tempo muda por fora (clique na timeline) ou a timeline é editada.
  const storeTime = useEditor((s) => s.time);
  const lastEmitted = useRef(-1);
  useEffect(() => {
    if (playing) return;
    if (Math.abs(storeTime - lastEmitted.current) < 1e-6 && eng.current.clipId) return;
    lastEmitted.current = storeTime;
    setLocalTime(storeTime);
    seek(storeTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeTime, playing, placed]);

  useEffect(() => {
    const e = eng.current;
    if (!playing) {
      videos().forEach((v) => v.pause());
      cancelAnimationFrame(e.raf);
      return;
    }
    ensureAudio();
    e.audio?.resume();
    let t0 = useEditor.getState().time;
    if (t0 >= total - 0.05) t0 = 0;
    seek(t0);
    const start = videos()[e.active];
    start.play().catch(() => {});

    const loop = () => {
      const pl = e.placed;
      const cur = pl.find((p) => p.clip.id === e.clipId);
      const v = videos()[e.active];
      if (!cur) {
        useEditor.getState().setPlaying(false);
        return;
      }
      let t = cur.start + (v.currentTime - cur.clip.in) / cur.clip.speed;
      const nx = pl[cur.index + 1];
      const ov = nx ? overlapOf(e.tl.clips, nx.index) : 0;
      if (nx && ov > 0 && t >= nx.start) {
        const nv = videos()[1 - e.active];
        if (e.incoming !== nx.clip.id) {
          loadInto(nv, nx, sourceTimeAt(nx, t));
          nv.play().catch(() => {});
          e.incoming = nx.clip.id;
        }
        // acrossfade com curva linear: sai (1-u), entra u
        const u = Math.min(1, (t - nx.start) / ov);
        setGain(e.active, cur.clip.volume * (1 - u));
        setGain(1 - e.active, nx.clip.volume * u);
      }
      if (v.currentTime >= cur.clip.out - END_EPS || v.ended) {
        const next = pl[cur.index + 1];
        if (!next) {
          v.pause();
          lastEmitted.current = total;
          useEditor.getState().setTime(total);
          useEditor.getState().setPlaying(false);
          return;
        }
        v.pause();
        const nv = videos()[1 - e.active];
        const already = e.incoming === next.clip.id;
        if (!already) loadInto(nv, next, next.clip.in);
        e.active = 1 - e.active;
        e.clipId = next.clip.id;
        e.incoming = '';
        setGain(e.active, next.clip.volume);
        show(e.active);
        nv.play().catch(() => {});
        const after = pl[next.index + 1];
        if (after) setTimeout(() => loadInto(v, after, after.clip.in), 0);
        t = already ? next.start + (nv.currentTime - next.clip.in) / next.clip.speed : next.start;
      }
      t = Math.max(cur.start, Math.min(t, total));
      lastEmitted.current = t;
      setLocalTime(t);
      useEditor.getState().setTime(t);
      e.raf = requestAnimationFrame(loop);
    };
    e.raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(e.raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // ---- fundo desfocado (modo "blur") ----
  const activePlaced = clipAt(placed, Math.min(time, total - 0.001)) ?? placed[placed.length - 1];
  const activeClip = activePlaced?.clip;

  // ---- efeitos do trecho ativo (mesmas fórmulas da exportação) ----
  const fx = activePlaced ? clipFx(timeline.clips, activePlaced.index) : null;
  const localT = activePlaced ? Math.max(0, time - activePlaced.start) : 0;
  const zoom = activePlaced && fx ? zoomAt(activePlaced.clip, fx, localT) : 1;
  const fade = fx ? fadeAt(fx, localT) : null;
  const glitch = fx ? glitchAt(fx, localT) : null;
  const color = activeClip?.color && !isNeutral(activeClip.color) ? colorSvg(activeClip.color) : null;
  // Transição cruzada: o trecho que entra é desenhado por cima, com a mesma conta do xfade da exportação.
  const nextPlaced = activePlaced ? placed[activePlaced.index + 1] : undefined;
  const nextOv = nextPlaced ? overlapOf(timeline.clips, nextPlaced.index) : 0;
  const crossing = nextPlaced && nextOv > 0 && time >= nextPlaced.start ? crossAt(nextPlaced.clip.transition!.type, (time - nextPlaced.start) / nextOv) : null;
  const inClip = crossing ? nextPlaced!.clip : null;
  const inZoom = crossing && nextPlaced ? zoomAt(nextPlaced.clip, clipFx(timeline.clips, nextPlaced.index), time - nextPlaced.start) : 1;
  const inColor = inClip?.color && !isNeutral(inClip.color) ? colorSvg(inClip.color) : null;
  useLayoutEffect(() => {
    const e = eng.current;
    const [act, other] = [videos()[e.active], videos()[1 - e.active]];
    // Tremor de câmera: mesmo deslocamento (shakeAt) que o crop animado da exportação, com ampliação de 6%.
    const shakeOf = (c: VideoClip | null | undefined, lt: number) => (c?.effects?.includes('tremor') ? shakeAt(lt) : null);
    const paint = (v: HTMLVideoElement, c: VideoClip | null | undefined, z: number, tx: number, filter: string, ty = 0, sc = 1, lt = 0) => {
      const sh = shakeOf(c, lt);
      const zz = z * sc * (sh ? 1.06 : 1);
      v.style.transform = `${tx || ty || sh ? `translate(${tx + (sh?.x ?? 0)}%, ${ty + (sh?.y ?? 0)}%) ` : ''}${zz !== 1 ? `scale(${zz})` : ''}`;
      v.style.transformOrigin = c ? `${c.focusX * 100}% ${c.focusY * 100}%` : '';
      v.style.filter = filter;
    };
    paint(act, activeClip, zoom, (crossing?.out.tx ?? 0) + (glitch?.jump ?? 0), [color ? 'url(#orbit-color)' : '', glitch ? `drop-shadow(-${glitch.shift / 2}px 0 rgba(255,0,0,.75)) drop-shadow(${glitch.shift / 2}px 0 rgba(0,255,255,.75)) contrast(1.25)` : ''].filter(Boolean).join(' '), crossing?.out.ty ?? 0, crossing?.out.scale ?? 1, localT);
    act.style.opacity = '1';
    act.style.zIndex = '0';
    act.style.clipPath = 'none';
    if (crossing && e.incoming === inClip?.id) {
      paint(other, inClip, inZoom, crossing.in.tx, inColor ? 'url(#orbit-color-in)' : '', crossing.in.ty ?? 0, crossing.in.scale ?? 1, time - (nextPlaced?.start ?? 0));
      other.style.opacity = String(crossing.in.opacity);
      other.style.clipPath = crossing.in.clip;
      other.style.zIndex = '1';
    } else {
      other.style.opacity = '0';
      other.style.clipPath = 'none';
      other.style.zIndex = '0';
    }
  });

  // ---- música de fundo (ganho = mesma conta do ducking da exportação) ----
  const musicRef = useRef<HTMLAudioElement>(null);
  const speech = useMemo(() => speechIntervals(timeline), [timeline]);
  useEffect(() => {
    const a = musicRef.current;
    const m = timeline.music;
    if (!a || !m) return;
    const dur = a.duration || Infinity;
    const want = (m.offset + time) % dur;
    if (playing) {
      if (a.paused || Math.abs(a.currentTime - want) > 0.3) a.currentTime = want;
      if (a.paused) a.play().catch(() => {});
    } else {
      a.pause();
      a.currentTime = want;
    }
    a.volume = Math.min(1, musicGainAt(timeline, time, total, speech));
  }, [time, playing, timeline, total, speech]);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = bgRef.current;
      const v = videos()[eng.current.active];
      const clip = eng.current.placed.find((p) => p.clip.id === eng.current.clipId)?.clip;
      if (c && v && clip?.fit === 'blur' && v.videoWidth) {
        const ctx = c.getContext('2d')!;
        const k = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
        const dw = v.videoWidth * k;
        const dh = v.videoHeight * k;
        ctx.filter = `blur(${Math.max(4, (Math.min(c.width, c.height) / 40) * 1.6)}px) brightness(0.88)`;
        ctx.drawImage(v, (c.width - dw) * clip.focusX, (c.height - dh) * clip.focusY, dw, dh);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- legendas (libass) ----
  const jassub = useRef<JASSUB | null>(null);
  const ass = useMemo(() => buildAss(timeline), [timeline]);
  const font = timeline.captions.style.font;
  const textFonts = Array.from(new Set((timeline.texts ?? []).map((t) => t.font))).sort().join('|');
  const bold = timeline.captions.style.bold;
  useEffect(() => {
    const host = subRef.current;
    if (!host) return;
    // O canvas é criado aqui (e não no JSX) porque o controle de um canvas só pode ser
    // transferido para o worker uma única vez.
    const canvas = document.createElement('canvas');
    canvas.className = 'stage-layer';
    canvas.style.pointerEvents = 'none';
    host.appendChild(canvas);
    setCaptionError('');
    let inst: JASSUB | null = null;
    try {
      const fontUrl = `/api/fonts/file?family=${encodeURIComponent(font)}&bold=${bold ? 1 : 0}&brandId=${project.brandId}`;
      const extra: Record<string, string> = {};
      for (const fam of textFonts.split('|').filter((x) => x && x !== font)) extra[fam.toLowerCase()] = `/api/fonts/file?family=${encodeURIComponent(fam)}&bold=1&brandId=${project.brandId}`;
      inst = new JASSUB({ canvas, subContent: ass, availableFonts: { [font.toLowerCase()]: fontUrl, ...extra }, fonts: [fontUrl], defaultFont: font.toLowerCase(), queryFonts: false });
      jassub.current = inst;
      inst.ready.then(() => inst!.manualRender({ mediaTime: useEditor.getState().time, width: W, height: H, expectedDisplayTime: performance.now() }, true)).catch((e) => setCaptionError(String(e?.message ?? e)));
    } catch (e) {
      setCaptionError((e as Error).message);
    }
    return () => {
      jassub.current = null;
      inst?.destroy().catch(() => {});
      canvas.remove();
    };
    // a instância é recriada quando muda a fonte (o arquivo de fonte precisa ser recarregado)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [font, bold, W, H, textFonts]);

  useEffect(() => {
    const j = jassub.current;
    if (!j) return;
    const id = setTimeout(() => {
      j.ready.then(async () => {
        await j.renderer.setTrack(ass);
        j.manualRender({ mediaTime: useEditor.getState().time, width: W, height: H, expectedDisplayTime: performance.now() }, true);
      });
    }, 60);
    return () => clearTimeout(id);
  }, [ass, W, H]);

  useEffect(() => {
    const j = jassub.current;
    if (!j || !j.renderer) return;
    j.manualRender({ mediaTime: time, width: W, height: H, expectedDisplayTime: performance.now() }).catch(() => {});
  }, [time, W, H]);

  // ---- arrastar logo/imagem/faixa na prévia (com quadros-chave, grava no instante do cursor) ----
  const drag = useRef<{ id: string; kind: 'overlay' | 'layer'; dx: number; dy: number; before: Timeline } | null>(null);
  const onOverlayDown = (e: React.PointerEvent, id: string, kind: 'overlay' | 'layer' = 'overlay') => {
    e.preventDefault();
    e.stopPropagation();
    const st = useEditor.getState();
    st.select({ kind, id });
    const tl = st.timeline!;
    const cur =
      kind === 'overlay'
        ? (() => { const o = tl.overlays.find((x) => x.id === id)!; return transformAt(overlayBase(o), o.keyframes, st.time - o.start); })()
        : (() => { const l = (tl.layers ?? []).find((x) => x.id === id)!; return transformAt(l, l.keyframes, st.time - l.start); })();
    const r = stageRef.current!.getBoundingClientRect();
    drag.current = { id, kind, dx: (e.clientX - r.left) / r.width - cur.x, dy: (e.clientY - r.top) / r.height - cur.y, before: tl };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onOverlayMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = stageRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width - d.dx));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height - d.dy));
    const st = useEditor.getState();
    const tl = d.before;
    if (d.kind === 'overlay') st.preview({ ...tl, overlays: tl.overlays.map((o) => (o.id === d.id ? setAt(o, overlayBase(o), o.start, st.time, { x, y }) : o)) });
    else st.preview({ ...tl, layers: (tl.layers ?? []).map((l) => (l.id === d.id ? setAt(l, l, l.start, st.time, { x, y }) : l)) });
  };
  const onOverlayUp = () => {
    if (drag.current) useEditor.getState().endGesture(drag.current.before, 'Mover elemento');
    drag.current = null;
  };

  const vertical = H / W > 1.5;
  const empty = !placed.length;

  return (
    <div ref={wrapRef} className="stage-wrap" onClick={() => useEditor.getState().select(null)}>
      <div ref={stageRef} className="stage" style={{ width: size.w, height: size.h }}>
        <canvas ref={bgRef} width={Math.max(2, Math.round(size.w / 2))} height={Math.max(2, Math.round(size.h / 2))} className="stage-layer" style={{ opacity: activeClip?.fit === 'blur' ? 1 : 0 }} />
        <video ref={v0} className="stage-layer" playsInline preload="auto" />
        <video ref={v1} className="stage-layer" playsInline preload="auto" style={{ opacity: 0 }} />
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
          <filter id="orbit-color-in" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR type="linear" slope={inColor?.slope ?? 1} intercept={inColor?.intercept ?? 0} />
              <feFuncG type="linear" slope={inColor?.slope ?? 1} intercept={inColor?.intercept ?? 0} />
              <feFuncB type="linear" slope={inColor?.slope ?? 1} intercept={inColor?.intercept ?? 0} />
            </feComponentTransfer>
            <feColorMatrix type="matrix" values={inColor?.matrix ?? '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0'} />
          </filter>
          <filter id="orbit-color" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR type="linear" slope={color?.slope ?? 1} intercept={color?.intercept ?? 0} />
              <feFuncG type="linear" slope={color?.slope ?? 1} intercept={color?.intercept ?? 0} />
              <feFuncB type="linear" slope={color?.slope ?? 1} intercept={color?.intercept ?? 0} />
            </feComponentTransfer>
            <feColorMatrix type="matrix" values={color?.matrix ?? '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0'} />
          </filter>
        </svg>
        {fade && <div className="stage-layer" style={{ background: fade.color, opacity: fade.alpha, pointerEvents: 'none' }} />}
        {activeClip?.effects?.includes('vinheta') && <div className="stage-layer" style={{ pointerEvents: 'none', background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 48%, rgba(0,0,0,0.62) 100%)' }} />}
        {activeClip?.effects?.includes('barras') && (
          <>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${barHeight(W, H) * 100}%`, background: '#000', pointerEvents: 'none', zIndex: 2 }} />
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${barHeight(W, H) * 100}%`, background: '#000', pointerEvents: 'none', zIndex: 2 }} />
          </>
        )}
        {timeline.music && <audio ref={musicRef} src={media.original(timeline.music.assetId)} preload="auto" loop />}
        {stackedLayers(timeline).map((l) => (
          <LayerView
            key={l.id}
            layer={l}
            asset={assets[l.assetId]}
            time={time}
            total={total}
            playing={playing}
            selected={selection?.kind === 'layer' && selection.id === l.id}
            onDown={(e) => onOverlayDown(e, l.id, 'layer')}
            onMove={onOverlayMove}
            onUp={onOverlayUp}
          />
        ))}
        {(timeline.audioClips ?? []).map((a) => <AudioClipPlayer key={a.id} clip={a} time={time} total={total} playing={playing} />)}
        {timeline.overlays.map((o) => {
          const a = assets[o.assetId];
          if (!a?.meta.width || !a.meta.height) return null;
          const visible = time >= o.start && time < o.end;
          const tr = transformAt(overlayBase(o), o.keyframes, time - o.start);
          const sel = selection?.kind === 'overlay' && selection.id === o.id;
          return (
            <img
              key={o.id}
              src={media.original(o.assetId)}
              alt=""
              draggable={false}
              className={`stage-overlay ${sel ? 'sel' : ''}`}
              style={{ left: `${tr.x * 100}%`, top: `${tr.y * 100}%`, width: `${o.width * tr.scale * 100}%`, transform: `translate(-50%, -50%) rotate(${tr.rotation}deg)`, opacity: visible ? Math.max(0, Math.min(1, tr.opacity)) : sel ? 0.25 : 0 }}
              onPointerDown={(e) => onOverlayDown(e, o.id)}
              onPointerMove={onOverlayMove}
              onPointerUp={onOverlayUp}
              onClick={(e) => e.stopPropagation()}
            />
          );
        })}
        <div ref={subRef} className="stage-layer" style={{ pointerEvents: 'none', zIndex: 4 }} />
        {showSafe && vertical && (
          <div className="safe-guides" aria-hidden>
            <div style={{ top: 0, left: 0, right: 0, height: `${SAFE_AREAS_VERTICAL.top * 100}%` }} />
            <div style={{ bottom: 0, left: 0, right: 0, height: `${SAFE_AREAS_VERTICAL.bottom * 100}%` }} />
            <div style={{ top: `${SAFE_AREAS_VERTICAL.top * 100}%`, bottom: `${SAFE_AREAS_VERTICAL.bottom * 100}%`, right: 0, width: `${SAFE_AREAS_VERTICAL.right * 100}%` }} />
            <span>Área coberta pela interface das redes</span>
          </div>
        )}
        {empty && <div className="stage-empty">Adicione um vídeo da aba Mídia para começar</div>}
      </div>
      {captionError && <div className="stage-warn">Prévia das legendas indisponível neste navegador ({captionError}). A exportação não é afetada.</div>}
    </div>
  );
}

/** Mantém um elemento de mídia no instante certo do arquivo (tolerância maior durante a reprodução). */
function syncMedia(el: HTMLMediaElement | null, visible: boolean, target: number, playing: boolean) {
  if (!el) return;
  if (!visible) {
    if (!el.paused) el.pause();
    return;
  }
  if (playing) {
    if (el.paused || Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
  }
}

/** Faixa livre: mesma geometria do FFmpeg (centro em x/y, largura × escala, rotação no centro, opacidade). */
function LayerView({ layer: l, asset, time, total, playing, selected, onDown, onMove, onUp }: { layer: LayerClip; asset?: Asset; time: number; total: number; playing: boolean; selected: boolean; onDown: (e: React.PointerEvent) => void; onMove: (e: React.PointerEvent) => void; onUp: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const isVideo = asset?.kind === 'video';
  const lt = time - l.start;
  const visible = lt >= 0 && lt < Math.min(layerDuration(l), total - l.start);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.volume = Math.min(1, Math.max(0, l.volume));
    v.muted = l.volume <= 0;
    syncMedia(v, visible, l.in + Math.max(0, lt), playing);
  }, [visible, lt, playing, l.in, l.volume]);
  if (!asset) return null;
  const tr = transformAt(l, l.keyframes, Math.max(0, lt));
  const cover = l.mode === 'cover';
  const style: React.CSSProperties = {
    left: `${tr.x * 100}%`,
    top: `${tr.y * 100}%`,
    width: cover ? '100%' : `${l.width * tr.scale * 100}%`,
    height: cover ? '100%' : 'auto',
    aspectRatio: cover ? undefined : `${asset.meta.width ?? 16} / ${asset.meta.height ?? 9}`,
    objectFit: 'cover',
    transform: `translate(-50%, -50%)${cover ? ` scale(${tr.scale})` : ''} rotate(${tr.rotation}deg)`,
    opacity: visible ? Math.max(0, Math.min(1, tr.opacity)) : selected ? 0.2 : 0,
  };
  const common = { className: `stage-overlay ${selected ? 'sel' : ''}`, style, draggable: false, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onClick: (e: React.MouseEvent) => e.stopPropagation() };
  return isVideo ? <video ref={ref} src={media.proxy(l.assetId)} playsInline preload="auto" {...common} /> : <img src={media.original(l.assetId)} alt="" {...common} />;
}

function AudioClipPlayer({ clip, time, total, playing }: { clip: AudioClip; time: number; total: number; playing: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const lt = time - clip.start;
  const visible = lt >= 0 && lt < Math.min(layerDuration(clip), total - clip.start);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = Math.min(1, audioClipGain(clip, time));
    syncMedia(a, visible, clip.in + Math.max(0, lt), playing);
  }, [visible, lt, playing, clip, time]);
  return <audio ref={ref} src={media.original(clip.assetId)} preload="auto" />;
}
