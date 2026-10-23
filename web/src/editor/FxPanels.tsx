// Painéis de efeitos, textos e música.
import { useEditor } from './store.ts';
import { updateTimeline } from './actions.ts';
import { addAudioClip } from './LayerPanels.tsx';
import { RhythmSection } from './RhythmPanel.tsx';
import { useApp } from '../lib/store.ts';
import { Field } from '../components/ui.tsx';
import { UploadButton } from '../pages/Library.tsx';
import { COLOR_PRESETS, colorFromPreset, TRANSITIONS } from '../../../shared/effects.ts';
import { textDefaults } from '../../../shared/edit-actions.ts';
import { fmtTime, timelineDuration, uid } from '../../../shared/timeline.ts';
import type { ColorAdjust, MusicTrack, TextClip, TextStyleKind, TransitionType, VideoClip } from '../../../shared/types.ts';
import { Plus, Trash2, Music } from 'lucide-react';

export function EffectsPanel() {
  const timeline = useEditor((s) => s.timeline)!;
  const selection = useEditor((s) => s.selection);
  const clip = selection?.kind === 'clip' ? timeline.clips.find((c) => c.id === selection.id) : null;
  const idx = clip ? timeline.clips.indexOf(clip) : -1;
  const setClips = (fn: (c: VideoClip, i: number) => VideoClip, label: string) => updateTimeline((tl) => ({ ...tl, clips: tl.clips.map(fn) }), label);
  const target = (c: VideoClip) => !clip || c.id === clip.id;
  const color = clip?.color ?? colorFromPreset('none');
  const setColor = (patch: Partial<ColorAdjust>) => setClips((c) => (target(c) ? { ...c, color: { ...(c.color ?? colorFromPreset('none')), ...patch, preset: patch.preset ?? 'custom' } } : c), 'Cor');

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="alert info small">{clip ? `Editando o trecho ${idx + 1}.` : 'Nenhum trecho selecionado: as alterações valem para o vídeo todo. Clique num trecho da timeline para editar só ele.'}</div>
      <Field label="Filtro">
        <div className="preset-grid">
          {Object.entries(COLOR_PRESETS).map(([k, p]) => (
            <button key={k} className={`preset ${(clip ? color.preset : timeline.clips[0]?.color?.preset ?? 'none') === k ? 'on' : ''}`} onClick={() => setClips((c) => (target(c) ? { ...c, color: colorFromPreset(k) } : c), 'Filtro')}>
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      {clip && (
        <>
          {(['brightness', 'contrast', 'saturation'] as const).map((k) => (
            <Field key={k} label={`${{ brightness: 'Brilho', contrast: 'Contraste', saturation: 'Saturação' }[k]}: ${Math.round(color[k] * 100)}%`}>
              <input type="range" min={k === 'saturation' ? 0 : 0.5} max={k === 'saturation' ? 2 : 1.5} step={0.01} value={color[k]} onChange={(e) => setColor({ [k]: Number(e.target.value) })} />
            </Field>
          ))}
          <Field label={`Temperatura: ${color.temperature > 0 ? 'quente' : color.temperature < 0 ? 'fria' : 'neutra'}`}>
            <input type="range" min={-1} max={1} step={0.05} value={color.temperature} onChange={(e) => setColor({ temperature: Number(e.target.value) })} />
          </Field>
        </>
      )}
      <Field label="Zoom" help={clip ? 'Aproximação animada ao longo do trecho.' : 'Aplica em todos os trechos.'}>
        <div className="row wrap" style={{ gap: 4 }}>
          {[
            ['Nenhum', undefined],
            ['Aproximar', { from: 1, to: 1.15 }],
            ['Afastar', { from: 1.15, to: 1 }],
            ['Ênfase fixa', { from: 1.2, to: 1.2 }],
          ].map(([l, z]) => (
            <button key={l as string} className="btn sm" onClick={() => setClips((c) => (target(c) ? { ...c, zoom: z as VideoClip['zoom'] } : c), 'Zoom')}>
              {l as string}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Transição de entrada" help={clip ? (idx === 0 ? 'O primeiro trecho não tem transição de entrada.' : 'Entre o trecho anterior e este.') : 'Aplica em todos os cortes.'}>
        <div className="row wrap" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => setClips((c) => (target(c) ? { ...c, transition: undefined } : c), 'Transição')}>Corte seco</button>
          {(Object.keys(TRANSITIONS) as TransitionType[]).map((t) => (
            <button key={t} className={`btn sm ${clip?.transition?.type === t ? 'primary' : ''}`} disabled={idx === 0} onClick={() => setClips((c, i) => (target(c) && i > 0 ? { ...c, transition: { type: t, duration: c.transition?.duration ?? 0.5 } } : c), 'Transição')}>
              {TRANSITIONS[t]}
            </button>
          ))}
        </div>
        <span className="faint small">As transições "cruzadas" mostram os dois trechos ao mesmo tempo e encurtam o vídeo pela duração da transição.</span>
      </Field>
      {clip?.transition && (
        <Field label={`Duração da transição: ${clip.transition.duration.toFixed(1)}s`}>
          <input type="range" min={0.2} max={2} step={0.1} value={clip.transition.duration} onChange={(e) => setClips((c) => (c.id === clip.id ? { ...c, transition: { ...c.transition!, duration: Number(e.target.value) } } : c), 'Tempo do elemento')} />
        </Field>
      )}
      <RhythmSection />
    </div>
  );
}

const KINDS: { k: TextStyleKind; label: string }[] = [
  { k: 'title', label: 'Título' },
  { k: 'lower', label: 'Lower third' },
  { k: 'cta', label: 'Chamada (CTA)' },
];

export function TextPanel() {
  const timeline = useEditor((s) => s.timeline)!;
  const time = useEditor((s) => s.time);
  const brandId = useEditor((s) => s.project!.brandId);
  const brand = useApp((s) => s.brands.find((b) => b.id === brandId));
  const texts = timeline.texts ?? [];
  const total = timelineDuration(timeline);
  const add = (kind: TextStyleKind) => {
    const t: TextClip = { id: uid('t_'), start: Math.min(time, Math.max(0, total - 1)), end: Math.min(total, time + 3), text: kind === 'cta' ? 'Siga para mais' : kind === 'lower' ? 'Nome • Cargo' : 'Seu título', kind, anim: kind === 'lower' ? 'slide' : 'pop', ...textDefaults(kind, timeline, { transcripts: {}, assets: {}, brand: { colors: brand?.profile.colors.map((c) => c.hex) ?? [], logoAssetId: null } }) };
    updateTimeline((tl) => ({ ...tl, texts: [...(tl.texts ?? []), t] }), 'Adicionar texto');
  };
  const set = (id: string, patch: Partial<TextClip>, label = 'Tempo do elemento') => updateTimeline((tl) => ({ ...tl, texts: (tl.texts ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)) }), label);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {KINDS.map((k) => (
          <button key={k.k} className="btn sm" onClick={() => add(k.k)}>
            <Plus size={12} /> {k.label}
          </button>
        ))}
      </div>
      <span className="faint small">Entra no ponto do cursor da timeline. Mesma renderização na prévia e no vídeo final.</span>
      {texts.map((t) => (
        <div key={t.id} className="card col" style={{ padding: 10, gap: 8, background: 'var(--surface-2)' }}>
          <textarea className="textarea" rows={2} defaultValue={t.text} key={t.text} onBlur={(e) => e.target.value !== t.text && set(t.id, { text: e.target.value }, 'Editar texto')} onKeyDown={(e) => e.stopPropagation()} />
          <div className="row wrap" style={{ gap: 6 }}>
            <select className="select sm" style={{ width: 'auto' }} value={t.anim} onChange={(e) => set(t.id, { anim: e.target.value as TextClip['anim'] }, 'Animação')}>
              <option value="pop">Pop</option>
              <option value="fade">Surgir</option>
              <option value="slide">Deslizar</option>
              <option value="none">Sem animação</option>
            </select>
            <input type="color" value={t.color} onChange={(e) => set(t.id, { color: e.target.value.toUpperCase() })} title="Cor do texto" />
            <input type="color" value={t.bg || '#000000'} onChange={(e) => set(t.id, { bg: e.target.value.toUpperCase() })} title="Cor do fundo" />
            <button className="btn ghost sm" onClick={() => set(t.id, { bg: t.bg ? '' : '#000000' })}>{t.bg ? 'Sem fundo' : 'Com fundo'}</button>
          </div>
          <Field label={`Tamanho ${t.size.toFixed(1)} · Altura ${Math.round(t.y * 100)}%`}>
            <input type="range" min={2} max={14} step={0.2} value={t.size} onChange={(e) => set(t.id, { size: Number(e.target.value) })} />
            <input type="range" min={0.05} max={0.95} step={0.01} value={t.y} onChange={(e) => set(t.id, { y: Number(e.target.value) })} />
          </Field>
          <div className="row small">
            <span className="mono">{fmtTime(t.start, true)} → {fmtTime(t.end, true)}</span>
            <button className="btn ghost sm" onClick={() => set(t.id, { start: time, end: Math.max(time + 0.3, t.end) })}>Início no cursor</button>
            <button className="btn ghost sm" onClick={() => set(t.id, { end: Math.max(t.start + 0.3, time) })}>Fim no cursor</button>
            <span className="spacer" />
            <button className="btn ghost sm icon" onClick={() => updateTimeline((tl) => ({ ...tl, texts: (tl.texts ?? []).filter((x) => x.id !== t.id) }), 'Excluir texto')}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function MusicPanel() {
  const timeline = useEditor((s) => s.timeline)!;
  const assets = useEditor((s) => s.assets);
  const project = useEditor((s) => s.project)!;
  const audios = Object.values(assets).filter((a) => a.kind === 'audio' && a.status === 'ready');
  const m = timeline.music;
  const set = (patch: Partial<MusicTrack>, label = 'Volume') => updateTimeline((tl) => ({ ...tl, music: tl.music ? { ...tl.music, ...patch } : tl.music }), label);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <span className="muted small" style={{ flex: 1 }}>Use músicas que você tem direito de usar. Registre a origem nas etiquetas.</span>
        <UploadButton brandId={project.brandId} accept="audio/*" label="Enviar" onUploaded={() => useEditor.getState().refreshAssets()} />
      </div>
      <div className="label">Faixas de áudio (narração, efeitos)</div>
      <p className="faint small" style={{ margin: 0 }}>Entra no cursor, numa faixa própria, com volume, fades e redução de ruído.</p>
      {audios.map((a) => (
        <button key={'ac' + a.id} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => addAudioClip(a)}>
          <Plus size={14} /> <span className="ellipsis">{a.name}</span>
        </button>
      ))}
      <div className="label" style={{ marginTop: 6 }}>Trilha de fundo (com ducking)</div>
      {audios.map((a) => (
        <button key={a.id} className={`btn sm ${m?.assetId === a.id ? 'primary' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => updateTimeline((tl) => ({ ...tl, music: { assetId: a.id, volume: 0.35, ducking: true, duckLevel: 0.25, fadeIn: 0.5, fadeOut: 1.5, offset: 0 } }), 'Adicionar música')}>
          <Music size={14} /> <span className="ellipsis">{a.name}</span>
        </button>
      ))}
      {!audios.length && <p className="faint small">Nenhuma música na biblioteca desta marca.</p>}
      {m && (
        <>
          <Field label={`Volume da música: ${Math.round(m.volume * 100)}%`}>
            <input type="range" min={0} max={1} step={0.01} value={m.volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
          </Field>
          <label className="row small">
            <input type="checkbox" checked={m.ducking} onChange={(e) => set({ ducking: e.target.checked }, 'Ducking')} /> Abaixar a música quando houver fala
          </label>
          {m.ducking && (
            <Field label={`Volume durante a fala: ${Math.round(m.duckLevel * 100)}% do normal`} help="Usa os tempos da transcrição.">
              <input type="range" min={0} max={1} step={0.05} value={m.duckLevel} onChange={(e) => set({ duckLevel: Number(e.target.value) })} />
            </Field>
          )}
          <Field label={`Início dentro da música: ${m.offset.toFixed(0)}s`}>
            <input type="range" min={0} max={Math.max(1, (assets[m.assetId]?.meta.duration ?? 60) - 1)} step={1} value={m.offset} onChange={(e) => set({ offset: Number(e.target.value) })} />
          </Field>
          <button className="btn ghost danger sm" onClick={() => updateTimeline((tl) => ({ ...tl, music: null }), 'Remover música')}>
            <Trash2 size={14} /> Remover música
          </button>
        </>
      )}
    </div>
  );
}
