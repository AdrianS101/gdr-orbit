import { useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, FileDown, FileUp, Trash2, Merge, ChevronLeft, ChevronRight, Save, Mic } from 'lucide-react';
import { useEditor } from './store.ts';
import { generateCaptions, updateTimeline } from './actions.ts';
import { api } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { Field, Progress } from '../components/ui.tsx';
import { cueText, exportSrt, importSrt, mapCuesToTimeline, mergeCues, setCueSpan, setCueText } from '../../../shared/captions.ts';
import { fmtTime } from '../../../shared/timeline.ts';
import type { CaptionPreset, CaptionStyle } from '../../../shared/types.ts';

const PRESETS: { id: CaptionPreset; label: string; hint: string }[] = [
  { id: 'highlight', label: 'Destaque', hint: 'Palavra falada na cor de destaque' },
  { id: 'pop', label: 'Pop', hint: 'Palavra falada cresce e muda de cor' },
  { id: 'karaoke', label: 'Karaokê', hint: 'Preenche conforme a fala' },
  { id: 'classic', label: 'Clássica', hint: 'Bloco estático com contorno' },
  { id: 'box', label: 'Caixa', hint: 'Texto sobre fundo sólido' },
];

function TranscribeBox() {
  const timeline = useEditor((s) => s.timeline)!;
  const assets = useEditor((s) => s.assets);
  const transcripts = useEditor((s) => s.transcripts);
  const jobs = useApp((s) => s.jobs);
  const [model, setModel] = useState('Xenova/whisper-small');
  const [models, setModels] = useState<Record<string, { label: string; hint: string }>>({});
  useEffect(() => {
    api.get('/api/transcribe/models').then(setModels, () => {});
  }, []);
  useEffect(
    () =>
      onJob((j) => {
        if (j.type === 'transcribe' && j.status === 'done' && j.assetId) useEditor.getState().loadTranscript(j.assetId);
      }),
    [],
  );
  const used = Array.from(new Set(timeline.clips.map((c) => c.assetId))).filter((id) => assets[id]?.meta.hasAudio);
  const start = async (assetId: string) => {
    try {
      await api.post(`/api/assets/${assetId}/transcribe`, { model });
    } catch (e) {
      showError(e);
    }
  };
  if (!used.length) return <p className="muted small">Adicione um vídeo com áudio para transcrever.</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      {used.map((id) => {
        const job = Object.values(jobs).find((j) => j.type === 'transcribe' && j.assetId === id && (j.status === 'running' || j.status === 'queued' || j.status === 'failed'));
        const done = !!transcripts[id];
        return (
          <div key={id} className="card" style={{ padding: 10, background: 'var(--surface-2)' }}>
            <div className="row small">
              <Mic size={14} />
              <span className="ellipsis" style={{ flex: 1 }}>{assets[id]?.name}</span>
              {done ? <span className="badge success">Transcrito</span> : !job && <button className="btn sm" onClick={() => start(id)}>Transcrever</button>}
              {done && !job && (
                <button className="btn ghost sm" title="Transcrever novamente" onClick={() => start(id)}>
                  Refazer
                </button>
              )}
            </div>
            {job && job.status !== 'failed' && (
              <div className="col" style={{ gap: 4, marginTop: 8 }}>
                <Progress value={job.progress} indeterminate={job.status === 'queued'} />
                <span className="faint small">{job.message}</span>
              </div>
            )}
            {job?.status === 'failed' && (
              <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>
                {job.error}{' '}
                <button className="btn ghost sm" onClick={() => api.post(`/api/jobs/${job.id}/retry`).catch(showError)}>Tentar de novo</button>
              </div>
            )}
          </div>
        );
      })}
      {Object.keys(models).length > 0 && (
        <Field label="Qualidade da transcrição" help={models[model]?.hint}>
          <select className="select sm" value={model} onChange={(e) => setModel(e.target.value)}>
            {Object.entries(models).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

function StyleEditor() {
  const style = useEditor((s) => s.timeline!.captions.style);
  const brandId = useEditor((s) => s.project!.brandId);
  const brand = useApp((s) => s.brands.find((b) => b.id === brandId));
  const [fonts, setFonts] = useState<{ suggested: string[]; fonts: { family: string; source: string }[] }>({ suggested: [], fonts: [] });
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    api.get(`/api/fonts?brandId=${brandId}`).then(setFonts, () => {});
  }, [brandId]);
  const set = (patch: Partial<CaptionStyle>, label = 'Estilo da legenda') => updateTimeline((tl) => ({ ...tl, captions: { ...tl.captions, style: { ...tl.captions.style, ...patch } } }), label);
  const brandFonts = fonts.fonts.filter((f) => f.source === 'marca');
  const saveAsBrandDefault = async () => {
    if (!brand) return;
    try {
      await api.put(`/api/brands/${brand.id}`, { profile: { captionStyle: style } });
      await useApp.getState().loadBrands();
      useApp.getState().toast({ kind: 'success', title: 'Estilo salvo como padrão da marca', hint: 'Novos projetos desta marca começam com este estilo.' });
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button key={p.id} className={`preset ${style.preset === p.id ? 'on' : ''}`} onClick={() => set({ preset: p.id }, 'Estilo de animação')} title={p.hint}>
            <span className={`preset-demo ${p.id}`}>
              <i>Seu</i> <b style={{ color: p.id === 'classic' || p.id === 'box' ? undefined : style.highlightColor }}>texto</b>
            </span>
            {p.label}
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Texto">
          <input type="color" value={style.textColor} onChange={(e) => set({ textColor: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Destaque">
          <input type="color" value={style.highlightColor} onChange={(e) => set({ highlightColor: e.target.value.toUpperCase() })} />
        </Field>
        <Field label={style.preset === 'box' ? 'Fundo' : 'Contorno'}>
          <input type="color" value={style.preset === 'box' ? style.boxColor : style.outlineColor} onChange={(e) => set(style.preset === 'box' ? { boxColor: e.target.value.toUpperCase() } : { outlineColor: e.target.value.toUpperCase() })} />
        </Field>
        {brand && brand.profile.colors.length > 0 && (
          <Field label="Cores da marca">
            <div className="row" style={{ gap: 4 }}>
              {brand.profile.colors.map((c) => (
                <button key={c.hex} className="swatch" style={{ background: c.hex, cursor: 'pointer' }} title={`Usar ${c.name || c.hex} como destaque`} onClick={() => set({ highlightColor: c.hex })} />
              ))}
            </div>
          </Field>
        )}
      </div>
      <Field label="Fonte">
        <select className="select sm" value={style.font} onChange={(e) => set({ font: e.target.value }, 'Fonte da legenda')}>
          {brandFonts.length > 0 && (
            <optgroup label="Fontes da marca">
              {brandFonts.map((f) => (
                <option key={f.family}>{f.family}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Recomendadas">
            {fonts.suggested.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </optgroup>
          <optgroup label="Todas instaladas">
            {fonts.fonts
              .filter((f) => f.source !== 'marca')
              .map((f) => (
                <option key={f.family}>{f.family}</option>
              ))}
          </optgroup>
        </select>
      </Field>
      <Field label={`Tamanho: ${style.size.toFixed(1)}`}>
        <input type="range" min={3} max={12} step={0.1} value={style.size} onChange={(e) => set({ size: Number(e.target.value) })} />
      </Field>
      <Field label={`Posição vertical: ${Math.round(style.posY * 100)}%`} help="Ative as guias de área segura na prévia para evitar a interface das redes.">
        <input type="range" min={0.08} max={0.92} step={0.01} value={style.posY} onChange={(e) => set({ posY: Number(e.target.value) })} />
      </Field>
      <label className="row small">
        <input type="checkbox" checked={style.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} /> Tudo em maiúsculas
      </label>
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdvanced(!advanced)}>
        {advanced ? 'Ocultar ajustes avançados' : 'Ajustes avançados'}
      </button>
      {advanced && (
        <div className="col" style={{ gap: 10 }}>
          <label className="row small">
            <input type="checkbox" checked={style.bold} onChange={(e) => set({ bold: e.target.checked })} /> Negrito (para fontes que não são "Black")
          </label>
          {style.preset !== 'box' ? (
            <Field label={`Contorno: ${style.outline}%`}>
              <input type="range" min={0} max={20} step={1} value={style.outline} onChange={(e) => set({ outline: Number(e.target.value) })} />
            </Field>
          ) : (
            <Field label={`Opacidade do fundo: ${Math.round(style.boxOpacity * 100)}%`}>
              <input type="range" min={0.2} max={1} step={0.05} value={style.boxOpacity} onChange={(e) => set({ boxOpacity: Number(e.target.value) })} />
            </Field>
          )}
          <Field label={`Sombra: ${style.shadow}%`}>
            <input type="range" min={0} max={12} step={1} value={style.shadow} onChange={(e) => set({ shadow: Number(e.target.value) })} />
          </Field>
          <Field label={`Caracteres por linha: ${style.maxCharsPerLine}`} help="Quebra as linhas automaticamente. Use Enter no texto para quebrar manualmente.">
            <input type="range" min={8} max={42} step={1} value={style.maxCharsPerLine} onChange={(e) => set({ maxCharsPerLine: Number(e.target.value) })} />
          </Field>
          <Field label={`Palavras por legenda (ao gerar): ${style.maxWordsPerCue}`}>
            <input type="range" min={1} max={12} step={1} value={style.maxWordsPerCue} onChange={(e) => set({ maxWordsPerCue: Number(e.target.value) })} />
          </Field>
          {brand && (
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={saveAsBrandDefault}>
              <Save size={14} /> Salvar como estilo padrão de {brand.name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CueList() {
  const timeline = useEditor((s) => s.timeline)!;
  const selection = useEditor((s) => s.selection);
  const display = useMemo(() => mapCuesToTimeline(timeline), [timeline]);
  const listRef = useRef<HTMLDivElement>(null);
  const selId = selection?.kind === 'cue' ? selection.id : null;

  useEffect(() => {
    if (!selId) return;
    listRef.current?.querySelector(`[data-cue="${selId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selId]);

  const cueById = (id: string) => timeline.captions.cues.find((c) => c.id === id)!;
  const replace = (id: string, next: any, label: string) =>
    updateTimeline((tl) => ({ ...tl, captions: { ...tl.captions, cues: tl.captions.cues.map((c) => (c.id === id ? next : c)) } }), label);

  const nudge = (id: string, edge: 'start' | 'end', dt: number) => {
    const c = cueById(id);
    const s = c.words[0].s;
    const e = c.words[c.words.length - 1].e;
    replace(id, edge === 'start' ? setCueSpan(c, Math.min(e - 0.05, s + dt), e) : setCueSpan(c, s, Math.max(s + 0.05, e + dt)), 'Ajustar tempo da legenda');
  };

  const merge = (id: string) => {
    const idx = timeline.captions.cues.findIndex((c) => c.id === id);
    const next = timeline.captions.cues[idx + 1];
    if (!next || next.assetId !== timeline.captions.cues[idx].assetId) return;
    updateTimeline((tl) => {
      const cues = [...tl.captions.cues];
      cues.splice(idx, 2, mergeCues(cues[idx], cues[idx + 1]));
      return { ...tl, captions: { ...tl.captions, cues } };
    }, 'Juntar legendas');
  };

  const seen = new Set<string>();
  return (
    <div className="cue-list" ref={listRef}>
      {display.map((d) => {
        const dup = seen.has(d.cueId);
        seen.add(d.cueId);
        const cue = cueById(d.cueId);
        const sel = selId === d.cueId;
        return (
          <div key={d.key} data-cue={dup ? undefined : d.cueId} className={`cue-row ${sel ? 'sel' : ''}`} onClick={() => (useEditor.getState().select({ kind: 'cue', id: d.cueId }), useEditor.getState().setTime(d.start + 0.01))}>
            <div className="row small faint" style={{ gap: 4 }}>
              <span className="mono">{fmtTime(d.start, true)}</span>
              {sel && !dup && (
                <>
                  <button className="btn ghost sm icon" title="Início −0,1 s" onClick={(e) => (e.stopPropagation(), nudge(d.cueId, 'start', -0.1))}><ChevronLeft size={12} /></button>
                  <button className="btn ghost sm icon" title="Início +0,1 s" onClick={(e) => (e.stopPropagation(), nudge(d.cueId, 'start', 0.1))}><ChevronRight size={12} /></button>
                </>
              )}
              <span className="spacer" />
              {sel && !dup && (
                <>
                  <button className="btn ghost sm icon" title="Fim −0,1 s" onClick={(e) => (e.stopPropagation(), nudge(d.cueId, 'end', -0.1))}><ChevronLeft size={12} /></button>
                  <button className="btn ghost sm icon" title="Fim +0,1 s" onClick={(e) => (e.stopPropagation(), nudge(d.cueId, 'end', 0.1))}><ChevronRight size={12} /></button>
                </>
              )}
              <span className="mono">{fmtTime(d.end, true)}</span>
            </div>
            {dup ? (
              <div className="small faint">{cueText(cue)} (repetida em trecho duplicado)</div>
            ) : (
              <textarea
                key={cueText(cue)}
                className="cue-text"
                defaultValue={cueText(cue)}
                rows={Math.max(1, cueText(cue).split('\n').length)}
                onFocus={() => useEditor.getState().select({ kind: 'cue', id: d.cueId })}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v === cueText(cue)) return;
                  const next = setCueText(cue, v);
                  if (next) replace(cue.id, next, 'Corrigir texto da legenda');
                  else updateTimeline((tl) => ({ ...tl, captions: { ...tl.captions, cues: tl.captions.cues.filter((c) => c.id !== cue.id) } }), 'Excluir legenda');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
                  e.stopPropagation();
                }}
              />
            )}
            {sel && !dup && (
              <div className="row" style={{ gap: 4 }}>
                <button className="btn ghost sm" onClick={(e) => (e.stopPropagation(), merge(d.cueId))}><Merge size={12} /> Juntar com a próxima</button>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={(e) => (e.stopPropagation(), updateTimeline((tl) => ({ ...tl, captions: { ...tl.captions, cues: tl.captions.cues.filter((c) => c.id !== d.cueId) } }), 'Excluir legenda'))}><Trash2 size={12} /></button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CaptionsPanel() {
  const timeline = useEditor((s) => s.timeline)!;
  const transcripts = useEditor((s) => s.transcripts);
  const project = useEditor((s) => s.project)!;
  const fileRef = useRef<HTMLInputElement>(null);
  const hasCues = timeline.captions.cues.length > 0;
  const anyTranscript = timeline.clips.some((c) => transcripts[c.assetId]);

  const generate = () => {
    if (hasCues && !confirm('Gerar novamente substitui as legendas atuais (inclusive correções). Você pode desfazer com Ctrl+Z. Continuar?')) return;
    const r = generateCaptions();
    useApp.getState().toast({ kind: r.created ? 'success' : 'info', title: r.created ? `${r.created} legendas criadas` : 'Nenhuma fala encontrada para legendar', hint: r.missing.length ? `Sem transcrição: ${r.missing.join(', ')}` : 'Revise o texto na lista abaixo.' });
  };

  const downloadSrt = () => {
    const blob = new Blob([exportSrt(timeline)], { type: 'application/x-subrip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name}.srt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onSrt = async (f: File) => {
    const r = importSrt(timeline, await f.text());
    if (!r.cues.length) return useApp.getState().toast({ kind: 'error', title: 'Nenhuma legenda válida no arquivo SRT', hint: 'Confira se os tempos do SRT correspondem ao vídeo da timeline.' });
    updateTimeline((tl) => ({ ...tl, captions: { ...tl.captions, enabled: true, cues: r.cues } }), 'Importar SRT');
    useApp.getState().toast({ kind: 'success', title: `${r.cues.length} legendas importadas`, hint: r.skipped ? `${r.skipped} bloco(s) fora da timeline foram ignorados.` : undefined });
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <section className="col" style={{ gap: 8 }}>
        <div className="label">1. Transcrição da fala</div>
        <TranscribeBox />
      </section>
      <section className="col" style={{ gap: 8 }}>
        <div className="label">2. Legendas no vídeo</div>
        <div className="row wrap">
          <button className="btn primary sm" disabled={!anyTranscript} onClick={generate} title={anyTranscript ? '' : 'Transcreva o vídeo primeiro'}>
            <Wand2 size={14} /> {hasCues ? 'Gerar novamente' : 'Gerar legendas'}
          </button>
          <label className="row small" style={{ marginLeft: 'auto' }}>
            <input type="checkbox" checked={timeline.captions.enabled} onChange={(e) => updateTimeline((tl) => ({ ...tl, captions: { ...tl.captions, enabled: e.target.checked } }), e.target.checked ? 'Mostrar legendas' : 'Ocultar legendas')} /> Mostrar
          </label>
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={() => fileRef.current?.click()}><FileUp size={14} /> Importar SRT</button>
          <button className="btn ghost sm" disabled={!hasCues} onClick={downloadSrt}><FileDown size={14} /> Exportar SRT</button>
          <input ref={fileRef} type="file" accept=".srt" hidden onChange={(e) => (e.target.files?.[0] && onSrt(e.target.files[0]), (e.target.value = ''))} />
        </div>
      </section>
      {hasCues && (
        <>
          <section className="col" style={{ gap: 8 }}>
            <div className="label">3. Estilo</div>
            <StyleEditor />
          </section>
          <section className="col" style={{ gap: 8 }}>
            <div className="label">4. Revisar texto e tempo</div>
            <div className="faint small">Clique para editar. Ctrl+Enter confirma; Enter quebra a linha.</div>
            <CueList />
          </section>
        </>
      )}
    </div>
  );
}
