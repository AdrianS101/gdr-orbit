import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Scissors, Trash2, Copy, ZoomIn, ZoomOut, Maximize2, Captions, Image as ImageIcon, Film, Layers, AudioLines } from 'lucide-react';
import { layerDuration } from '../../../shared/keyframes.ts';
import { useEditor } from './store.ts';
import { media } from '../lib/api.ts';
import { clipDuration, fmtTime, layoutClips, timelineDuration, trimClip, moveClip, MIN_CLIP } from '../../../shared/timeline.ts';
import { mapCuesToTimeline } from '../../../shared/captions.ts';
import type { Asset, AudioClip, LayerClip, Timeline, VideoClip } from '../../../shared/types.ts';
import { splitAtPlayhead, deleteSelection, duplicateSelection } from './actions.ts';

const HEAD = 104;

const peaksCache = new Map<string, Promise<Uint8Array>>();
function loadPeaks(assetId: string) {
  if (!peaksCache.has(assetId)) {
    peaksCache.set(
      assetId,
      fetch(media.waveform(assetId))
        .then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0)))
        .then((b) => new Uint8Array(b)),
    );
  }
  return peaksCache.get(assetId)!;
}

const Waveform = memo(function Waveform({ clip, width }: { clip: VideoClip; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    loadPeaks(clip.assetId).then((peaks) => {
      const c = ref.current;
      if (!alive || !c || !peaks.length) return;
      const w = Math.min(8000, Math.max(1, Math.round(width)));
      c.width = w;
      c.height = 28;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, w, 28);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      const span = clip.out - clip.in;
      for (let x = 0; x < w; x++) {
        const a = Math.floor((clip.in + (x / w) * span) * 100);
        const b = Math.max(a + 1, Math.floor((clip.in + ((x + 1) / w) * span) * 100));
        let m = 0;
        for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
        const h = Math.max(1, Math.sqrt(m / 255) * 26);
        ctx.fillRect(x, 28 - h, 1, h);
      }
    });
    return () => {
      alive = false;
    };
  }, [clip.assetId, clip.in, clip.out, width]);
  return <canvas ref={ref} className="clip-wave" style={{ width }} />;
});

function Filmstrip({ clip, asset, width }: { clip: VideoClip; asset?: Asset; width: number }) {
  const fs = asset?.filmstrip;
  if (!fs) return null;
  const tileW = (fs.tileW / fs.tileH) * 44;
  const n = Math.min(400, Math.ceil(width / tileW));
  const rows = Math.ceil(fs.frames / fs.cols);
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const s = clip.in + ((i * tileW) / width) * (clip.out - clip.in);
    const idx = Math.min(fs.frames - 1, Math.floor(s / fs.interval));
    const col = idx % fs.cols;
    const row = Math.floor(idx / fs.cols);
    tiles.push(
      <div
        key={i}
        style={{
          left: i * tileW,
          width: tileW,
          backgroundImage: `url(${media.filmstrip(clip.assetId)})`,
          backgroundSize: `${fs.cols * tileW}px ${rows * 44}px`,
          backgroundPosition: `-${col * tileW}px -${row * 44}px`,
        }}
      />,
    );
  }
  return <div className="clip-strip">{tiles}</div>;
}

export function TimelinePanel() {
  const timeline = useEditor((s) => s.timeline)!;
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const assets = useEditor((s) => s.assets);
  const playing = useEditor((s) => s.playing);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const placed = useMemo(() => layoutClips(timeline.clips), [timeline.clips]);
  const total = useMemo(() => timelineDuration(timeline), [timeline]);
  const cues = useMemo(() => mapCuesToTimeline(timeline), [timeline]);
  const width = Math.max(total * zoom + 200, 600);

  const xToTime = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + scrollRef.current!.scrollLeft - HEAD) / zoom));
  };

  const fit = () => {
    const w = scrollRef.current?.clientWidth ?? 800;
    useEditor.getState().setZoom(total > 0 ? (w - HEAD - 40) / total : 60);
  };
  useEffect(() => {
    if (total > 0) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.clips.length === 0]);

  // ---- arraste do cursor de reprodução ----
  const scrubbing = useRef(false);
  const onRulerDown = (e: React.PointerEvent) => {
    useEditor.getState().setPlaying(false);
    scrubbing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    useEditor.getState().setTime(xToTime(e.clientX));
  };
  const onRulerMove = (e: React.PointerEvent) => scrubbing.current && useEditor.getState().setTime(xToTime(e.clientX));
  const onRulerUp = () => (scrubbing.current = false);

  // ---- aparar e reordenar trechos ----
  const gesture = useRef<{ kind: 'trim-in' | 'trim-out' | 'move'; id: string; x0: number; before: Timeline; moved: boolean } | null>(null);
  const onClipDown = (e: React.PointerEvent, id: string, kind: 'trim-in' | 'trim-out' | 'move') => {
    e.stopPropagation();
    const st = useEditor.getState();
    st.setPlaying(false);
    st.select({ kind: 'clip', id });
    gesture.current = { kind, id, x0: e.clientX, before: st.timeline!, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onClipMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x0;
    if (!g.moved && Math.abs(dx) < 4) return;
    g.moved = true;
    const st = useEditor.getState();
    const before = g.before.clips.find((c) => c.id === g.id)!;
    const dur = assets[before.assetId]?.meta.duration ?? before.out;
    if (g.kind === 'trim-in') st.preview(trimClip(g.before, g.id, 'in', before.in + (dx / zoom) * before.speed, dur));
    else if (g.kind === 'trim-out') st.preview(trimClip(g.before, g.id, 'out', before.out + (dx / zoom) * before.speed, dur));
    else {
      const t = xToTime(e.clientX);
      const others = layoutClips(g.before.clips.filter((c) => c.id !== g.id));
      let idx = others.length;
      for (const p of others) if (t < (p.start + p.end) / 2) { idx = p.index; break; }
      setDropIndex(idx);
    }
  };
  const onClipUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const st = useEditor.getState();
    if (g.kind === 'move') {
      if (g.moved && dropIndex !== null) st.commit(moveClip(g.before, g.id, dropIndex), 'Reordenar trecho');
      else if (!g.moved) st.setTime(layoutClips(st.timeline!.clips).find((p) => p.clip.id === g.id)?.start ?? st.time);
      setDropIndex(null);
    } else st.endGesture(g.before, 'Aparar trecho');
  };

  // ---- elementos (logo/imagens) ----
  const og = useRef<{ kind: 'move' | 'in' | 'out'; id: string; x0: number; before: Timeline } | null>(null);
  const onOvDown = (e: React.PointerEvent, id: string, kind: 'move' | 'in' | 'out') => {
    e.stopPropagation();
    const st = useEditor.getState();
    st.select({ kind: 'overlay', id });
    st.setTab('elements');
    og.current = { kind, id, x0: e.clientX, before: st.timeline! };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onOvMove = (e: React.PointerEvent) => {
    const g = og.current;
    if (!g) return;
    const dt = (e.clientX - g.x0) / zoom;
    const st = useEditor.getState();
    st.preview({
      ...g.before,
      overlays: g.before.overlays.map((o) => {
        if (o.id !== g.id) return o;
        if (g.kind === 'in') return { ...o, start: Math.max(0, Math.min(o.end - MIN_CLIP, o.start + dt)) };
        if (g.kind === 'out') return { ...o, end: Math.max(o.start + MIN_CLIP, o.end + dt) };
        const len = o.end - o.start;
        const s = Math.max(0, o.start + dt);
        return { ...o, start: s, end: s + len };
      }),
    });
  };
  const onOvUp = () => {
    if (og.current) useEditor.getState().endGesture(og.current.before, 'Ajustar elemento');
    og.current = null;
  };

  // ---- faixas livres (vídeo/imagem) e faixas de áudio: mover e aparar ----
  const lg = useRef<{ list: 'layers' | 'audioClips'; kind: 'move' | 'in' | 'out'; id: string; x0: number; before: Timeline } | null>(null);
  const onLayerDown = (e: React.PointerEvent, list: 'layers' | 'audioClips', id: string, kind: 'move' | 'in' | 'out') => {
    e.stopPropagation();
    const st = useEditor.getState();
    st.setPlaying(false);
    st.select({ kind: list === 'layers' ? 'layer' : 'audio', id });
    lg.current = { list, kind, id, x0: e.clientX, before: st.timeline! };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onLayerMove = (e: React.PointerEvent) => {
    const g = lg.current;
    if (!g) return;
    const dt = (e.clientX - g.x0) / zoom;
    const items = (g.before[g.list] ?? []) as (LayerClip | AudioClip)[];
    const moved = items.map((l) => {
      if (l.id !== g.id) return l;
      const a = assets[l.assetId];
      const srcDur = a?.kind === 'image' ? Infinity : a?.meta.duration ?? l.out;
      if (g.kind === 'move') return { ...l, start: Math.max(0, l.start + dt) };
      if (g.kind === 'out') return { ...l, out: Math.min(srcDur, Math.max(l.in + MIN_CLIP, l.out + dt)) };
      // aparar o início mantém o fim no lugar
      const d = Math.max(-Math.min(l.start, a?.kind === 'image' ? l.start : l.in), Math.min(l.out - l.in - MIN_CLIP, dt));
      return { ...l, start: l.start + d, in: a?.kind === 'image' ? l.in : l.in + d, out: a?.kind === 'image' ? l.out - d : l.out };
    });
    useEditor.getState().preview({ ...g.before, [g.list]: moved });
  };
  const onLayerUp = () => {
    if (lg.current) useEditor.getState().endGesture(lg.current.before, 'Ajustar faixa');
    lg.current = null;
  };
  const layerTracks = useMemo(() => Array.from(new Set((timeline.layers ?? []).map((l) => l.track))).sort((a, b) => b - a), [timeline.layers]);
  const audioTracks = useMemo(() => Array.from(new Set((timeline.audioClips ?? []).map((l) => l.track))).sort((a, b) => a - b), [timeline.audioClips]);
  const kfMarks = (start: number, kfs?: { t: number }[]) => (kfs ?? []).map((k, i) => <span key={i} className="kf-mark" style={{ left: k.t * zoom - 4 }} title={`Quadro-chave em ${fmtTime(start + k.t, true)}`} />);

  const ticks = useMemo(() => {
    const step = zoom > 120 ? 1 : zoom > 40 ? 2 : zoom > 15 ? 5 : zoom > 6 ? 10 : 30;
    const out = [];
    for (let t = 0; t <= total + step; t += step) out.push(t);
    return { out, step };
  }, [zoom, total]);

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <button className="btn sm icon primary" onClick={() => useEditor.getState().setPlaying(!playing)} title="Reproduzir/pausar (Espaço)" disabled={!placed.length}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <TimeDisplay total={total} />
        <span className="tl-sep" />
        <button className="btn sm ghost" onClick={splitAtPlayhead} title="Dividir no cursor (S)" disabled={!placed.length}>
          <Scissors size={15} /> <span className="hide-mobile">Dividir</span>
        </button>
        <button className="btn sm ghost" onClick={duplicateSelection} disabled={!selection || selection.kind === 'cue'} title="Duplicar (Ctrl+D)">
          <Copy size={15} />
        </button>
        <button className="btn sm ghost" onClick={deleteSelection} disabled={!selection} title="Excluir seleção (Delete)">
          <Trash2 size={15} />
        </button>
        <span className="spacer" />
        <button className="btn sm ghost icon" onClick={() => useEditor.getState().setZoom(zoom / 1.4)} title="Diminuir zoom (-)">
          <ZoomOut size={15} />
        </button>
        <input type="range" min={4} max={400} value={zoom} onChange={(e) => useEditor.getState().setZoom(Number(e.target.value))} style={{ width: 110 }} aria-label="Zoom da timeline" />
        <button className="btn sm ghost icon" onClick={() => useEditor.getState().setZoom(zoom * 1.4)} title="Aumentar zoom (+)">
          <ZoomIn size={15} />
        </button>
        <button className="btn sm ghost icon" onClick={fit} title="Ajustar à largura">
          <Maximize2 size={15} />
        </button>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width: width + HEAD }}>
          <div className="tl-ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            <div className="tl-head" />
            {ticks.out.map((t) => (
              <div key={t} className="tick" style={{ left: HEAD + t * zoom }}>
                {fmtTime(t)}
              </div>
            ))}
          </div>

          <div className="tl-track captions-track" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            <div className="tl-head">
              <Captions size={14} /> Legendas
            </div>
            {timeline.captions.enabled &&
              cues.map((c) => {
                const sel = selection?.kind === 'cue' && selection.id === c.cueId;
                return (
                  <div
                    key={c.key}
                    className={`cue-block ${sel ? 'sel' : ''}`}
                    style={{ left: HEAD + c.start * zoom, width: Math.max(3, (c.end - c.start) * zoom - 1) }}
                    title={c.words.map((w) => w.text).join(' ')}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const st = useEditor.getState();
                      st.select({ kind: 'cue', id: c.cueId });
                      st.setTab('captions');
                      st.setPlaying(false);
                      st.setTime(c.start + 0.01);
                    }}
                  >
                    {c.words.map((w) => w.text).join(' ')}
                  </div>
                );
              })}
          </div>

          <div className="tl-track overlay-track" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            <div className="tl-head">
              <ImageIcon size={14} /> Elementos
            </div>
            {(timeline.texts ?? []).map((tx) => (
              <div key={tx.id} className="text-block" style={{ left: HEAD + tx.start * zoom, width: Math.max(6, (tx.end - tx.start) * zoom) }} title={tx.text} onPointerDown={(e) => { e.stopPropagation(); useEditor.getState().setTab('text'); useEditor.getState().setTime(tx.start + 0.01); }}>
                T {tx.text}
              </div>
            ))}
            {timeline.overlays.map((o) => {
              const sel = selection?.kind === 'overlay' && selection.id === o.id;
              return (
                <div key={o.id} className={`ov-block ${sel ? 'sel' : ''}`} style={{ left: HEAD + o.start * zoom, width: Math.max(6, (o.end - o.start) * zoom) }} onPointerDown={(e) => onOvDown(e, o.id, 'move')} onPointerMove={onOvMove} onPointerUp={onOvUp}>
                  <span className="handle l" onPointerDown={(e) => onOvDown(e, o.id, 'in')} />
                  <img src={media.original(o.assetId)} alt="" draggable={false} />
                  <span className="ellipsis">{assets[o.assetId]?.name ?? 'Imagem'}</span>
                  {kfMarks(o.start, o.keyframes)}
                  <span className="handle r" onPointerDown={(e) => onOvDown(e, o.id, 'out')} />
                </div>
              );
            })}
          </div>

          {layerTracks.map((tr) => (
            <div key={`v${tr}`} className="tl-track layer-track" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
              <div className="tl-head">
                <Layers size={14} /> Vídeo {tr + 1}
              </div>
              {(timeline.layers ?? []).filter((l) => l.track === tr).map((l) => {
                const sel = selection?.kind === 'layer' && selection.id === l.id;
                const a = assets[l.assetId];
                return (
                  <div key={l.id} className={`ov-block layer-block ${sel ? 'sel' : ''}`} style={{ left: HEAD + l.start * zoom, width: Math.max(6, layerDuration(l) * zoom) }} onPointerDown={(e) => onLayerDown(e, 'layers', l.id, 'move')} onPointerMove={onLayerMove} onPointerUp={onLayerUp}>
                    <span className="handle l" onPointerDown={(e) => onLayerDown(e, 'layers', l.id, 'in')} />
                    <img src={a?.kind === 'video' ? media.poster(l.assetId) : media.original(l.assetId)} alt="" draggable={false} />
                    <span className="ellipsis">{l.mode === 'cover' ? 'B-roll · ' : ''}{a?.name ?? 'Arquivo'}</span>
                    {kfMarks(l.start, l.keyframes)}
                    <span className="handle r" onPointerDown={(e) => onLayerDown(e, 'layers', l.id, 'out')} />
                  </div>
                );
              })}
            </div>
          ))}

          <div className="tl-track video-track" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            <div className="tl-head">
              <Film size={14} /> Vídeo
            </div>
            {placed.map((p) => {
              const sel = selection?.kind === 'clip' && selection.id === p.clip.id;
              const w = clipDuration(p.clip) * zoom;
              const a = assets[p.clip.assetId];
              return (
                <div
                  key={p.clip.id}
                  className={`clip ${sel ? 'sel' : ''}`}
                  style={{ left: HEAD + p.start * zoom, width: Math.max(4, w - 1) }}
                  onPointerDown={(e) => onClipDown(e, p.clip.id, 'move')}
                  onPointerMove={onClipMove}
                  onPointerUp={onClipUp}
                >
                  <Filmstrip clip={p.clip} asset={a} width={w} />
                  {a?.hasWaveform && <Waveform clip={p.clip} width={w} />}
                  <div className="clip-label ellipsis">
                    {p.clip.speed !== 1 && <b>{p.clip.speed}× </b>}
                    {a?.name}
                  </div>
                  <span className="handle l" onPointerDown={(e) => onClipDown(e, p.clip.id, 'trim-in')} title="Arraste para aparar o início" />
                  <span className="handle r" onPointerDown={(e) => onClipDown(e, p.clip.id, 'trim-out')} title="Arraste para aparar o fim" />
                </div>
              );
            })}
            {dropIndex !== null && <div className="drop-mark" style={{ left: HEAD + (layoutClips(timeline.clips.filter((c) => c.id !== gesture.current?.id))[dropIndex]?.start ?? total) * zoom }} />}
          </div>

          {audioTracks.map((tr) => (
            <div key={`a${tr}`} className="tl-track audio-track" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
              <div className="tl-head">
                <AudioLines size={14} /> Áudio {tr}
              </div>
              {(timeline.audioClips ?? []).filter((a) => a.track === tr).map((a) => {
                const sel = selection?.kind === 'audio' && selection.id === a.id;
                return (
                  <div key={a.id} className={`ov-block audio-block ${sel ? 'sel' : ''}`} style={{ left: HEAD + a.start * zoom, width: Math.max(6, layerDuration(a) * zoom) }} onPointerDown={(e) => onLayerDown(e, 'audioClips', a.id, 'move')} onPointerMove={onLayerMove} onPointerUp={onLayerUp}>
                    <span className="handle l" onPointerDown={(e) => onLayerDown(e, 'audioClips', a.id, 'in')} />
                    <span className="ellipsis">{assets[a.assetId]?.name ?? 'Áudio'}</span>
                    <span className="handle r" onPointerDown={(e) => onLayerDown(e, 'audioClips', a.id, 'out')} />
                  </div>
                );
              })}
            </div>
          ))}

          <Playhead zoom={zoom} />
        </div>
      </div>
    </div>
  );
}

function TimeDisplay({ total }: { total: number }) {
  const time = useEditor((s) => s.time);
  return (
    <span className="mono" style={{ minWidth: 130 }}>
      {fmtTime(time, true)} <span className="faint">/ {fmtTime(total, true)}</span>
    </span>
  );
}

function Playhead({ zoom }: { zoom: number }) {
  const time = useEditor((s) => s.time);
  return <div className="playhead" style={{ left: HEAD + time * zoom }} />;
}
