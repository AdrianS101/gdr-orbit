import { useEffect, useState } from 'react';
import { Plus, Film, Stamp, ImagePlus, Trash2 } from 'lucide-react';
import { useEditor } from './store.ts';
import { addImageOverlay, addVideo, deleteSelection, updateTimeline } from './actions.ts';
import { media } from '../lib/api.ts';
import { useApp, onJob } from '../lib/store.ts';
import { fmtDuration } from '../lib/format.ts';
import { Field, Progress } from '../components/ui.tsx';
import { UploadButton } from '../pages/Library.tsx';
import { FORMAT_PRESETS, makeFormat, defaultCaptionY, clipDuration, fmtTime } from '../../../shared/timeline.ts';
import type { FitMode, FormatPreset, OverlayClip, VideoClip } from '../../../shared/types.ts';

export function MediaPanel() {
  const assets = useEditor((s) => s.assets);
  const project = useEditor((s) => s.project)!;
  const jobs = useApp((s) => s.jobs);
  useEffect(() => onJob((j) => j.type === 'ingest' && (j.status === 'done' || j.status === 'failed') && useEditor.getState().refreshAssets()), []);
  const videos = Object.values(assets).filter((a) => a.kind === 'video').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <span className="muted small" style={{ flex: 1 }}>Vídeos da marca. Clique em + para colocar no fim da timeline.</span>
        <UploadButton brandId={project.brandId} accept="video/*,image/*,.ttf,.otf" label="Enviar" onUploaded={() => useEditor.getState().refreshAssets()} />
      </div>
      <div className="media-grid">
        {videos.map((a) => {
          const job = Object.values(jobs).find((j) => j.assetId === a.id && j.type === 'ingest' && (j.status === 'running' || j.status === 'queued'));
          const ready = a.status === 'ready';
          return (
            <div key={a.id} className="media-item">
              <div className="thumb">
                {ready ? <img src={media.poster(a.id)} alt="" loading="lazy" /> : <Film size={18} />}
                {a.meta.duration && <span className="dur">{fmtDuration(a.meta.duration)}</span>}
                {ready && (
                  <button className="btn primary sm icon add" title="Adicionar à timeline" onClick={() => addVideo(a)}>
                    <Plus size={14} />
                  </button>
                )}
              </div>
              <div className="small ellipsis" title={a.name}>{a.name}</div>
              {job && <Progress value={job.progress} indeterminate={job.status === 'queued'} />}
              {a.status === 'failed' && <span className="badge danger">Falhou ao preparar</span>}
            </div>
          );
        })}
        {!videos.length && <p className="muted small">Nenhum vídeo nesta marca ainda. Envie um arquivo.</p>}
      </div>
    </div>
  );
}

export function ElementsPanel() {
  const assets = useEditor((s) => s.assets);
  const project = useEditor((s) => s.project)!;
  const brand = useApp((s) => s.brands.find((b) => b.id === project.brandId));
  const images = Object.values(assets).filter((a) => a.kind === 'image' && a.status === 'ready');
  const logo = brand?.profile.logoAssetId ? assets[brand.profile.logoAssetId] : null;
  return (
    <div className="col" style={{ gap: 14 }}>
      <section className="col" style={{ gap: 8 }}>
        <div className="label">Logo da marca</div>
        {logo ? (
          <div className="row">
            <div className="thumb contain" style={{ width: 64, aspectRatio: '1', background: 'var(--bg)' }}>
              <img src={media.original(logo.id)} alt="" />
            </div>
            <button className="btn primary sm" onClick={() => addImageOverlay(logo, 'logo')}>
              <Stamp size={14} /> Aplicar logo
            </button>
          </div>
        ) : (
          <p className="muted small">Esta marca ainda não tem logo definido. Defina em Marcas → Identidade visual, ou use uma imagem abaixo.</p>
        )}
      </section>
      <section className="col" style={{ gap: 8 }}>
        <div className="row">
          <div className="label" style={{ flex: 1 }}>Imagens da marca</div>
          <UploadButton brandId={project.brandId} accept="image/png,image/jpeg,image/webp" label="Enviar" onUploaded={() => useEditor.getState().refreshAssets()} />
        </div>
        <div className="media-grid">
          {images.map((a) => (
            <div key={a.id} className="media-item">
              <div className="thumb contain" style={{ background: 'var(--bg)' }}>
                <img src={media.original(a.id)} alt="" loading="lazy" />
                <button className="btn primary sm icon add" title="Sobrepor no vídeo" onClick={() => addImageOverlay(a, 'logo')}>
                  <ImagePlus size={14} />
                </button>
              </div>
              <div className="small ellipsis">{a.name}</div>
            </div>
          ))}
        </div>
      </section>
      <div className="alert info small">Títulos, lower thirds, motion graphics, transições e trilhas chegam na Etapa 2.</div>
    </div>
  );
}

export function FormatPanel() {
  const timeline = useEditor((s) => s.timeline)!;
  const [custom, setCustom] = useState({ width: timeline.format.width, height: timeline.format.height });
  const apply = (preset: FormatPreset) => {
    const format = makeFormat(preset, custom, timeline.format.fps);
    updateTimeline((tl) => ({ ...tl, format, captions: { ...tl.captions, style: { ...tl.captions.style, posY: defaultCaptionY(format) } } }), 'Mudar formato');
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <Field label="Formato de saída" help="O vídeo é reenquadrado automaticamente. Ajuste o foco de cada trecho no painel à direita.">
        <div className="col" style={{ gap: 6 }}>
          {(Object.keys(FORMAT_PRESETS) as (keyof typeof FORMAT_PRESETS)[]).map((k) => (
            <button key={k} className={`btn sm ${timeline.format.preset === k ? 'primary' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => apply(k)}>
              {FORMAT_PRESETS[k].label} <span style={{ opacity: 0.7, fontWeight: 400 }}>· {FORMAT_PRESETS[k].hint}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Dimensão personalizada">
        <div className="row">
          <input className="input sm" type="number" value={custom.width} onChange={(e) => setCustom({ ...custom, width: Number(e.target.value) })} style={{ width: 90 }} />
          ×
          <input className="input sm" type="number" value={custom.height} onChange={(e) => setCustom({ ...custom, height: Number(e.target.value) })} style={{ width: 90 }} />
          <button className="btn sm" onClick={() => apply('custom')}>Aplicar</button>
        </div>
      </Field>
      <Field label="Quadros por segundo do projeto">
        <select className="select sm" value={timeline.format.fps} onChange={(e) => updateTimeline((tl) => ({ ...tl, format: { ...tl.format, fps: Number(e.target.value) } }), 'Mudar FPS')}>
          {[24, 25, 30, 50, 60].map((f) => (
            <option key={f} value={f}>{f} fps</option>
          ))}
        </select>
      </Field>
      <label className="row small">
        <input type="checkbox" checked={timeline.audio.normalize} onChange={(e) => updateTimeline((tl) => ({ ...tl, audio: { ...tl.audio, normalize: e.target.checked } }), 'Normalização de áudio')} />
        Normalizar volume na exportação (padrão das redes, −14 LUFS)
      </label>
    </div>
  );
}

function num(v: number, d = 2) {
  return Number(v.toFixed(d));
}

function ClipInspector({ clip }: { clip: VideoClip }) {
  const asset = useEditor((s) => s.assets[clip.assetId]);
  const set = (patch: Partial<VideoClip>, label: string) => updateTimeline((tl) => ({ ...tl, clips: tl.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)) }), label);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small faint ellipsis">{asset?.name}</div>
      <div className="small">
        Trecho {fmtTime(clip.in, true)} → {fmtTime(clip.out, true)} · duração {fmtTime(clipDuration(clip), true)}
      </div>
      <Field label="Velocidade">
        <div className="row wrap" style={{ gap: 4 }}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
            <button key={s} className={`btn sm ${clip.speed === s ? 'primary' : ''}`} onClick={() => set({ speed: s }, 'Velocidade')}>
              {s}×
            </button>
          ))}
        </div>
      </Field>
      <Field label={`Volume: ${Math.round(clip.volume * 100)}%`}>
        <input type="range" min={0} max={2} step={0.05} value={clip.volume} onChange={(e) => set({ volume: Number(e.target.value) }, 'Volume')} />
      </Field>
      <Field label="Enquadramento">
        <select className="select sm" value={clip.fit} onChange={(e) => set({ fit: e.target.value as FitMode }, 'Enquadramento')}>
          <option value="cover">Preencher (corta as bordas)</option>
          <option value="blur">Inteiro com fundo desfocado</option>
          <option value="contain">Inteiro com barras pretas</option>
        </select>
      </Field>
      {clip.fit !== 'contain' && (
        <>
          <Field label={`Foco horizontal: ${Math.round(clip.focusX * 100)}%`} help="Escolha qual parte da imagem fica visível ao reenquadrar.">
            <input type="range" min={0} max={1} step={0.01} value={clip.focusX} onChange={(e) => set({ focusX: num(Number(e.target.value)) }, 'Foco')} />
          </Field>
          <Field label={`Foco vertical: ${Math.round(clip.focusY * 100)}%`}>
            <input type="range" min={0} max={1} step={0.01} value={clip.focusY} onChange={(e) => set({ focusY: num(Number(e.target.value)) }, 'Foco')} />
          </Field>
        </>
      )}
      <button className="btn ghost danger sm" onClick={deleteSelection}>
        <Trash2 size={14} /> Excluir trecho
      </button>
    </div>
  );
}

function OverlayInspector({ o }: { o: OverlayClip }) {
  const asset = useEditor((s) => s.assets[o.assetId]);
  const set = (patch: Partial<OverlayClip>, label: string) => updateTimeline((tl) => ({ ...tl, overlays: tl.overlays.map((x) => (x.id === o.id ? { ...x, ...patch } : x)) }), label);
  const corner = (cx: number, cy: number) => set({ x: cx, y: cy }, 'Posição do elemento');
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small faint ellipsis">{asset?.name}</div>
      <div className="faint small">Arraste o elemento na prévia para posicionar.</div>
      <Field label={`Tamanho: ${Math.round(o.width * 100)}% da largura`}>
        <input type="range" min={0.03} max={1} step={0.005} value={o.width} onChange={(e) => set({ width: Number(e.target.value) }, 'Tamanho do elemento')} />
      </Field>
      <Field label={`Opacidade: ${Math.round(o.opacity * 100)}%`}>
        <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => set({ opacity: Number(e.target.value) }, 'Opacidade')} />
      </Field>
      <Field label="Posições rápidas">
        <div className="pos-grid">
          {[0.15, 0.5, 0.85].flatMap((y) =>
            [0.15, 0.5, 0.85].map((x) => (
              <button key={`${x}-${y}`} className="btn sm" onClick={() => corner(x === 0.15 ? o.width / 2 + 0.05 : x === 0.85 ? 1 - o.width / 2 - 0.05 : 0.5, y)} aria-label="Posicionar">
                •
              </button>
            )),
          )}
        </div>
      </Field>
      <div className="row">
        <Field label="Início (s)">
          <input className="input sm" type="number" step={0.1} value={num(o.start, 2)} onChange={(e) => set({ start: Math.max(0, Math.min(o.end - 0.1, Number(e.target.value))) }, 'Tempo do elemento')} />
        </Field>
        <Field label="Fim (s)">
          <input className="input sm" type="number" step={0.1} value={num(o.end, 2)} onChange={(e) => set({ end: Math.max(o.start + 0.1, Number(e.target.value)) }, 'Tempo do elemento')} />
        </Field>
      </div>
      <button className="btn ghost danger sm" onClick={deleteSelection}>
        <Trash2 size={14} /> Remover elemento
      </button>
    </div>
  );
}

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const timeline = useEditor((s) => s.timeline)!;
  if (!selection || selection.kind === 'cue') return null;
  const clip = selection.kind === 'clip' ? timeline.clips.find((c) => c.id === selection.id) : null;
  const ov = selection.kind === 'overlay' ? timeline.overlays.find((o) => o.id === selection.id) : null;
  if (!clip && !ov) return null;
  return (
    <aside className="inspector">
      <div className="label" style={{ marginBottom: 10 }}>{clip ? 'Trecho de vídeo' : 'Elemento'}</div>
      {clip && <ClipInspector clip={clip} />}
      {ov && <OverlayInspector o={ov} />}
    </aside>
  );
}
