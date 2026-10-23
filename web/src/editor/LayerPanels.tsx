// Faixas livres (PiP/B-roll), faixas de áudio, quadros-chave e redução de ruído — painéis do editor.
import { useState } from 'react';
import { Trash2, Diamond, Headphones } from 'lucide-react';
import { useEditor } from './store.ts';
import { deleteSelection, updateTimeline } from './actions.ts';
import { Field } from '../components/ui.tsx';
import { clamp, fmtTime, timelineDuration, uid } from '../../../shared/timeline.ts';
import { addKeyframe, DENOISE_LABEL, KF_EPS, layerDuration, newLayer, overlayBase, setAt, sortKfs, transformAt } from '../../../shared/keyframes.ts';
import type { Asset, AudioClip, DenoiseLevel, Keyframe, LayerClip, OverlayClip, Transform } from '../../../shared/types.ts';

const st = () => useEditor.getState();
const num = (v: number, d = 2) => Number(v.toFixed(d));

export function addLayer(a: Asset, mode: 'free' | 'cover') {
  const { timeline, time, commit, select } = st();
  if (!timeline) return;
  const total = timelineDuration(timeline);
  const start = clamp(time, 0, Math.max(0, total - 0.5));
  const dur = a.kind === 'video' ? Math.min(a.meta.duration ?? 5, Math.max(1, total - start)) : Math.min(4, Math.max(1, total - start));
  // Vai para uma faixa livre no instante do cursor; se ocupada, sobe uma faixa.
  const used = (timeline.layers ?? []).filter((l) => l.start < start + dur && l.start + layerDuration(l) > start).map((l) => l.track);
  let track = 1;
  while (used.includes(track)) track++;
  const l = newLayer(a.id, a.kind === 'video' ? 'video' : 'image', dur, start, mode, track);
  commit({ ...timeline, layers: [...(timeline.layers ?? []), l] }, mode === 'cover' ? 'Adicionar B-roll' : 'Adicionar sobreposição');
  select({ kind: 'layer', id: l.id });
}

export function addAudioClip(a: Asset) {
  const { timeline, time, commit, select } = st();
  if (!timeline || !a.meta.duration) return;
  const total = timelineDuration(timeline);
  const start = clamp(time, 0, Math.max(0, total - 0.5));
  const dur = Math.min(a.meta.duration, Math.max(0.5, total - start));
  const used = (timeline.audioClips ?? []).filter((c) => c.start < start + dur && c.start + layerDuration(c) > start).map((c) => c.track);
  let track = 1;
  while (used.includes(track)) track++;
  const c: AudioClip = { id: uid('a_'), assetId: a.id, track, start, in: 0, out: dur, volume: 1, fadeIn: 0.2, fadeOut: 0.5 };
  commit({ ...timeline, audioClips: [...(timeline.audioClips ?? []), c] }, 'Adicionar áudio');
  select({ kind: 'audio', id: c.id });
}

export function DenoiseField({ assetId, from, value, onChange }: { assetId: string; from: number; value?: DenoiseLevel; onChange: (v: DenoiseLevel | undefined) => void }) {
  const [sample, setSample] = useState<string | null>(null);
  return (
    <Field label="Redução de ruído" help="Aplicada na exportação. A prévia toca o áudio original; use a amostra para ouvir o resultado.">
      <select className="select sm" value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as DenoiseLevel | undefined)}>
        <option value="">Desligada</option>
        {Object.entries(DENOISE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {value && (
        <div className="col" style={{ gap: 4, marginTop: 6 }}>
          <button className="btn sm" onClick={() => setSample(`/api/assets/${assetId}/denoise-sample?from=${num(from, 1)}&level=${value}&k=${Date.now()}`)}>
            <Headphones size={14} /> Ouvir amostra tratada (15 s)
          </button>
          {sample && <audio src={sample} controls autoPlay style={{ width: '100%' }} />}
        </div>
      )}
    </Field>
  );
}

/** Sliders de posição/escala/rotação/opacidade + lista de quadros-chave. Com quadros-chave, editar grava no instante do cursor. */
function TransformEditor<T extends { keyframes?: Keyframe[] }>({ item, base, start, duration, apply, showScale = true }: { item: T; base: Transform; start: number; duration: number; apply: (next: T, label: string) => void; showScale?: boolean }) {
  const time = useEditor((s) => s.time);
  const lt = clamp(time - start, 0, duration);
  const cur = transformAt(base, item.keyframes, lt);
  const kfs = sortKfs(item.keyframes);
  const onKf = kfs.some((k) => Math.abs(k.t - lt) < KF_EPS);
  const inRange = time >= start - 1e-3 && time <= start + duration + 1e-3;
  const set = (patch: Partial<Transform>) => apply(setAt(item as any, base, start, start + lt, patch) as T, 'Transformar');
  return (
    <div className="col" style={{ gap: 10 }}>
      {!!kfs.length && <div className="faint small">{onKf ? 'Editando o quadro-chave no cursor.' : 'Ao mexer, cria um quadro-chave no cursor.'}</div>}
      <Field label={`Horizontal: ${Math.round(cur.x * 100)}%`}>
        <input type="range" min={-0.2} max={1.2} step={0.005} value={cur.x} onChange={(e) => set({ x: Number(e.target.value) })} />
      </Field>
      <Field label={`Vertical: ${Math.round(cur.y * 100)}%`}>
        <input type="range" min={-0.2} max={1.2} step={0.005} value={cur.y} onChange={(e) => set({ y: Number(e.target.value) })} />
      </Field>
      {showScale && (
        <Field label={`Escala: ${Math.round(cur.scale * 100)}%`}>
          <input type="range" min={0.1} max={3} step={0.01} value={cur.scale} onChange={(e) => set({ scale: Number(e.target.value) })} />
        </Field>
      )}
      <Field label={`Rotação: ${Math.round(cur.rotation)}°`}>
        <input type="range" min={-180} max={180} step={1} value={cur.rotation} onChange={(e) => set({ rotation: Number(e.target.value) })} />
      </Field>
      <Field label={`Opacidade: ${Math.round(cur.opacity * 100)}%`}>
        <input type="range" min={0} max={1} step={0.01} value={cur.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} />
      </Field>
      <Field label="Quadros-chave" help="Posicione o cursor, adicione um quadro e mude os valores. Entre quadros o movimento é calculado igual na prévia e na exportação.">
        <div className="kf-list">
          <button className="btn sm" disabled={!inRange} onClick={() => apply(addKeyframe(item, base, start, start + lt), 'Adicionar quadro-chave')} title={inRange ? '' : 'Coloque o cursor dentro do item'}>
            <Diamond size={13} /> Adicionar quadro-chave em {fmtTime(start + lt, true)}
          </button>
          {kfs.map((k, i) => (
            <div key={i} className="row small">
              <button className="btn ghost sm" onClick={() => { st().setPlaying(false); st().setTime(start + k.t + 0.001); }}>
                <Diamond size={11} /> {fmtTime(start + k.t, true)}
              </button>
              <span className="faint">{Math.round(k.x * 100)}/{Math.round(k.y * 100)} · {Math.round(k.scale * 100)}% · {Math.round(k.rotation)}° · {Math.round(k.opacity * 100)}%</span>
              <span className="spacer" />
              {i > 0 && (
                <select className="select sm" value={k.ease ?? 'linear'} aria-label="Movimento até este quadro" onChange={(e) => apply({ ...item, keyframes: kfs.map((x, j) => (j === i ? { ...x, ease: e.target.value as Keyframe['ease'] } : x)) }, 'Suavização')}>
                  <option value="smooth">Suave</option>
                  <option value="linear">Linear</option>
                </select>
              )}
              <button className="icon-btn" aria-label="Excluir quadro-chave" onClick={() => apply({ ...item, keyframes: kfs.filter((_, j) => j !== i) }, 'Excluir quadro-chave')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </Field>
    </div>
  );
}

export function LayerInspector({ l }: { l: LayerClip }) {
  const asset = useEditor((s) => s.assets[l.assetId]);
  const time = useEditor((s) => s.time);
  const set = (next: LayerClip, label: string) => updateTimeline((tl) => ({ ...tl, layers: (tl.layers ?? []).map((x) => (x.id === l.id ? next : x)) }), label);
  const patch = (p: Partial<LayerClip>, label: string) => set({ ...l, ...p }, label);
  const isVideo = asset?.kind === 'video';
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small faint ellipsis">{asset?.name}</div>
      <div className="faint small">Arraste na prévia para posicionar. {fmtTime(l.start, true)} → {fmtTime(l.start + layerDuration(l), true)}</div>
      <div className="row">
        <Field label="Modo">
          <select className="select sm" value={l.mode} onChange={(e) => patch({ mode: e.target.value as LayerClip['mode'], ...(e.target.value === 'cover' ? { x: 0.5, y: 0.5, width: 1 } : { width: 0.42 }) }, 'Modo da faixa')}>
            <option value="free">Sobreposição (PiP)</option>
            <option value="cover">Tela cheia (B-roll)</option>
          </select>
        </Field>
        <Field label="Faixa">
          <select className="select sm" value={l.track} onChange={(e) => patch({ track: Number(e.target.value) }, 'Mudar faixa')}>
            {[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>Vídeo {t + 1}</option>)}
          </select>
        </Field>
      </div>
      {l.mode === 'free' && (
        <Field label={`Largura: ${Math.round(l.width * 100)}% do quadro`}>
          <input type="range" min={0.05} max={1} step={0.005} value={l.width} onChange={(e) => patch({ width: Number(e.target.value) }, 'Tamanho do elemento')} />
        </Field>
      )}
      <TransformEditor item={l} base={l} start={l.start} duration={layerDuration(l)} apply={set} />
      {isVideo && (
        <>
          <Field label={`Volume: ${Math.round(l.volume * 100)}%`}>
            <input type="range" min={0} max={1} step={0.05} value={l.volume} onChange={(e) => patch({ volume: Number(e.target.value) }, 'Volume da faixa')} />
          </Field>
          {l.volume > 0 && asset?.meta.hasAudio && <DenoiseField assetId={l.assetId} from={l.in + Math.max(0, time - l.start)} value={l.denoise} onChange={(v) => patch({ denoise: v }, 'Redução de ruído')} />}
        </>
      )}
      <button className="btn ghost danger sm" onClick={deleteSelection}>
        <Trash2 size={14} /> Remover da faixa
      </button>
    </div>
  );
}

export function OverlayTransform({ o }: { o: OverlayClip }) {
  const set = (next: OverlayClip, label: string) => updateTimeline((tl) => ({ ...tl, overlays: tl.overlays.map((x) => (x.id === o.id ? next : x)) }), label);
  // Sem quadros-chave, a escala de um elemento é a própria largura (slider "Tamanho").
  return <TransformEditor item={o} base={overlayBase(o)} start={o.start} duration={o.end - o.start} apply={set} showScale={!!o.keyframes?.length} />;
}

export function AudioInspector({ a }: { a: AudioClip }) {
  const asset = useEditor((s) => s.assets[a.assetId]);
  const time = useEditor((s) => s.time);
  const patch = (p: Partial<AudioClip>, label: string) => updateTimeline((tl) => ({ ...tl, audioClips: (tl.audioClips ?? []).map((x) => (x.id === a.id ? { ...x, ...p } : x)) }), label);
  const d = layerDuration(a);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small faint ellipsis">{asset?.name}</div>
      <div className="faint small">{fmtTime(a.start, true)} → {fmtTime(a.start + d, true)} · arraste na timeline para mover ou aparar.</div>
      <Field label="Faixa">
        <select className="select sm" value={a.track} onChange={(e) => patch({ track: Number(e.target.value) }, 'Mudar faixa')}>
          {[1, 2, 3, 4].map((t) => <option key={t} value={t}>Áudio {t}</option>)}
        </select>
      </Field>
      <Field label={`Volume: ${Math.round(a.volume * 100)}%`}>
        <input type="range" min={0} max={1} step={0.05} value={a.volume} onChange={(e) => patch({ volume: Number(e.target.value) }, 'Volume da faixa')} />
      </Field>
      <div className="row">
        <Field label="Entrada suave (s)">
          <input className="input sm" type="number" min={0} step={0.1} value={num(a.fadeIn, 1)} onChange={(e) => patch({ fadeIn: clamp(Number(e.target.value), 0, d / 2) }, 'Fade')} />
        </Field>
        <Field label="Saída suave (s)">
          <input className="input sm" type="number" min={0} step={0.1} value={num(a.fadeOut, 1)} onChange={(e) => patch({ fadeOut: clamp(Number(e.target.value), 0, d / 2) }, 'Fade')} />
        </Field>
      </div>
      <DenoiseField assetId={a.assetId} from={a.in + Math.max(0, time - a.start)} value={a.denoise} onChange={(v) => patch({ denoise: v }, 'Redução de ruído')} />
      <button className="btn ghost danger sm" onClick={deleteSelection}>
        <Trash2 size={14} /> Remover áudio
      </button>
    </div>
  );
}
