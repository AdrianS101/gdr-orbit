// Cortes com IA (estilo Vizard): preferências → a IA lê a conversa inteira e gera os cortes → lista com nota,
// trecho, vídeo e ações (publicar, baixar, editar) + ações em massa e barra de ajustes para os selecionados.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Zap, Download, Trash2, Send, Pencil, Smartphone, Square, Monitor, VolumeX, Captions, Palette, Wand2, Mic, RefreshCcw, CheckSquare, Square as Box } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { Empty, Progress, Spinner } from '../components/ui.tsx';
import type { Asset } from '../../../shared/types.ts';
import type { EditAction } from '../../../shared/edit-actions.ts';

interface Clip {
  id: string;
  name: string;
  duration: number;
  format: string;
  meta: { score: number | null; title: string; hook: string; why: string | null; text: string | null; in: number; out: number; keywords: string[]; style: string };
  export: { id: string; size: number; current: boolean } | null;
  job: { id: string; status: string; progress: number; message: string; error: string | null } | null;
}

const LENGTHS = [['auto', 'Automático'], ['lt30', '< 30 s'], ['30-60', '30–60 s'], ['60-90', '60–90 s'], ['90-180', '90 s–3 min']] as const;
const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function ClipsPage() {
  const { assetId } = useParams();
  const nav = useNavigate();
  const jobs = useApp((s) => s.jobs);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [sort, setSort] = useState<'score' | 'time'>('score');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [showPrefs, setShowPrefs] = useState(false);
  const [transcribeJob, setTranscribeJob] = useState<string | null>(null);
  const [p, setP] = useState({ length: 'auto', countMode: 'auto' as 'auto' | 'fixed', count: 5, format: '9:16', style: 'animada', highlightKeywords: true, autoLight: true, autoReframe: true, removePauses: true, logo: true, autoExport: true, topics: '', moments: '' });

  const load = () => {
    api.get<Asset>(`/api/assets/${assetId}`).then(setAsset, showError);
    api.get<Clip[]>(`/api/assets/${assetId}/clips`).then((c) => {
      setClips(c);
      if (!c.length) setShowPrefs(true);
    }, showError);
  };
  useEffect(load, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Atualiza enquanto exporta / quando um trabalho deste vídeo termina.
  useEffect(() => onJob((j) => (j.type === 'render' || j.type === 'transcribe') && (j.status === 'done' || j.status === 'failed') && load()), [assetId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!clips?.some((c) => c.job && c.job.status !== 'failed')) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [clips]); // eslint-disable-line react-hooks/exhaustive-deps

  const transcribed = asset?.transcriptStatus === 'ready';
  const generate = async () => {
    if (!asset) return;
    if (!transcribed) {
      // Transcreve primeiro e continua sozinho quando terminar.
      const r = await api.post<{ jobId: string }>(`/api/assets/${asset.id}/transcribe`, {}).catch(showError);
      if (r) setTranscribeJob(r.jobId);
      return;
    }
    setBusy('Lendo a conversa inteira e escolhendo os melhores trechos…');
    try {
      const sug = await api.post<{ segments: any[]; note: string }>(`/api/assets/${asset.id}/reels/suggest`, { count: p.countMode === 'auto' ? 'auto' : p.count, length: p.length, topics: p.topics, moments: p.moments, viral: true });
      setNote(sug.note || '');
      if (!sug.segments.length) return;
      setBusy(`Montando ${sug.segments.length} corte(s): enquadramento, legenda, luz, ritmo…`);
      await api.post(`/api/assets/${asset.id}/reels/create`, { segments: sug.segments, viral: true, style: p.style, format: p.format, highlightKeywords: p.highlightKeywords, autoLight: p.autoLight, autoReframe: p.autoReframe, removePauses: p.removePauses, logo: p.logo, autoExport: p.autoExport, hookTitle: p.style === 'impacto' });
      setShowPrefs(false);
      load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy('');
    }
  };
  useEffect(() => {
    if (transcribeJob && jobs[transcribeJob]?.status === 'done') {
      setTranscribeJob(null);
      api.get<Asset>(`/api/assets/${assetId}`).then((a) => {
        setAsset(a);
        if (a.transcriptStatus === 'ready') setTimeout(generate, 50);
      });
    }
  }, [jobs, transcribeJob]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => [...(clips ?? [])].sort((a, b) => (sort === 'score' ? (b.meta.score ?? 0) - (a.meta.score ?? 0) : a.meta.in - b.meta.in)), [clips, sort]);
  const bulk = async (action: 'export' | 'delete' | 'post' | 'apply', extra: { edit?: EditAction; format?: string } = {}, ids = sel) => {
    if (!ids.length) return useApp.getState().toast({ kind: 'info', title: 'Selecione ao menos um corte.' });
    if (action === 'delete' && !confirm(`Excluir ${ids.length} corte(s)? Os projetos serão apagados.`)) return;
    try {
      const r = await api.post<{ results: { id: string; ok: boolean; detail?: string }[] }>('/api/clips/bulk', { ids, action, ...extra });
      const bad = r.results.filter((x) => !x.ok);
      if (action === 'apply' && r.results.some((x) => x.ok)) await api.post('/api/clips/bulk', { ids: r.results.filter((x) => x.ok).map((x) => x.id), action: 'export' });
      useApp.getState().toast({ kind: bad.length ? 'error' : 'success', title: { export: 'Exportando', delete: 'Excluído(s)', post: 'Rascunho(s) criado(s) no calendário', apply: 'Ajuste aplicado — reexportando' }[action], hint: bad.length ? bad.map((x) => x.detail).join(' · ') : action === 'post' ? 'Abra Conteúdo para escolher redes e horário.' : undefined });
      if (action === 'delete') setSel([]);
      if (action === 'post' && !bad.length) nav('/conteudo');
      load();
    } catch (e) {
      showError(e);
    }
  };
  const download = (ids = sel) => ids.forEach((id) => {
    const c = clips?.find((x) => x.id === id);
    if (c?.export) window.open(`/api/exports/${c.export.id}/file?download=1`, '_blank');
  });
  const tjob = transcribeJob ? jobs[transcribeJob] : null;

  if (!asset) return <Spinner />;
  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 10 }}>
          <Link to="/biblioteca" className="btn ghost icon" aria-label="Voltar"><ArrowLeft size={18} /></Link>
          <div>
            <h1 style={{ margin: 0 }}>Cortes com IA</h1>
            <p style={{ margin: 0 }}>{asset.name} · {mmss(asset.meta.duration ?? 0)}</p>
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setShowPrefs(!showPrefs)}><Zap size={16} /> {clips?.length ? 'Gerar novos cortes' : 'Preferências'}</button>
        </div>
      </div>

      {showPrefs && (
        <section className="card col clip-prefs" style={{ gap: 14, marginBottom: 16 }}>
          <b>Preferências dos cortes</b>
          <div className="col" style={{ gap: 6 }}>
            <span className="label">Duração preferida</span>
            <div className="row wrap" style={{ gap: 6 }}>{LENGTHS.map(([k, l]) => <button key={k} className={`chip-btn ${p.length === k ? 'on' : ''}`} onClick={() => setP({ ...p, length: k })}>{l}</button>)}</div>
          </div>
          <div className="row wrap" style={{ gap: 24 }}>
            <div className="col" style={{ gap: 6 }}>
              <span className="label">Quantidade de cortes</span>
              <div className="row" style={{ gap: 6 }}>
                <button className={`chip-btn ${p.countMode === 'auto' ? 'on' : ''}`} onClick={() => setP({ ...p, countMode: 'auto' })}>Automática (a IA decide)</button>
                <button className={`chip-btn ${p.countMode === 'fixed' ? 'on' : ''}`} onClick={() => setP({ ...p, countMode: 'fixed' })}>Escolher</button>
                {p.countMode === 'fixed' && <input className="input sm" type="number" min={1} max={20} value={p.count} onChange={(e) => setP({ ...p, count: Number(e.target.value) })} style={{ width: 70 }} />}
              </div>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="label">Formato</span>
              <div className="row" style={{ gap: 6 }}>{([['9:16', Smartphone, 'Reels, TikTok, Shorts'], ['1:1', Square, 'Feed'], ['16:9', Monitor, 'YouTube']] as const).map(([k, I, t]) => <button key={k} title={t} className={`chip-btn ${p.format === k ? 'on' : ''}`} onClick={() => setP({ ...p, format: k })}><I size={13} /> {k}</button>)}</div>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="label">Estilo</span>
              <select className="select sm" value={p.style} onChange={(e) => setP({ ...p, style: e.target.value })}>
                <option value="animada">Animada (palavra cresce, verde/amarelo)</option>
                <option value="podcast">Podcast cinematográfico (discreta, cor de cinema)</option>
                <option value="impacto">Impacto (legenda grande, cortes rápidos)</option>
              </select>
            </div>
          </div>
          <div className="row wrap small" style={{ gap: 16 }}>
            {([['autoReframe', 'Enquadrar a pessoa automaticamente'], ['highlightKeywords', 'Destacar palavras-chave'], ['autoLight', 'Corrigir a luz automaticamente'], ['removePauses', 'Remover pausas'], ['logo', 'Logo da marca'], ['autoExport', 'Já exportar os MP4']] as const).map(([k, l]) => (
              <label key={k} className="row"><input type="checkbox" checked={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.checked })} /> {l}</label>
            ))}
          </div>
          <label className="col" style={{ gap: 4 }}>
            <span className="label">Assuntos (opcional)</span>
            <input className="input" placeholder="Ex.: vendas, liderança, inteligência artificial" value={p.topics} onChange={(e) => setP({ ...p, topics: e.target.value })} />
          </label>
          <label className="col" style={{ gap: 4 }}>
            <span className="label">Momentos exatos / instruções (opcional)</span>
            <textarea className="textarea" rows={2} placeholder={'Ex.: "um corte de 02:10 a 03:05 e outro quando ele conta da portaria" — intervalos com horário viram cortes garantidos'} value={p.moments} onChange={(e) => setP({ ...p, moments: e.target.value })} />
          </label>
          {tjob ? (
            <div className="col" style={{ gap: 4 }}><Progress value={tjob.progress} indeterminate={tjob.status === 'queued'} /><span className="faint small">Transcrevendo ({tjob.message}) — depois os cortes são gerados sozinhos. Pode deixar esta tela aberta.</span></div>
          ) : (
            <button className="btn primary lg" disabled={!!busy} onClick={generate}>{busy ? <Spinner /> : <Zap size={18} />} {busy || (transcribed ? 'Gerar cortes com IA' : 'Transcrever e gerar cortes')}</button>
          )}
          {note && <div className="alert info small">{note}</div>}
        </section>
      )}

      {clips && !clips.length && !showPrefs && <Empty icon={<Zap size={32} />} title="Nenhum corte ainda">Abra as preferências e gere os cortes.</Empty>}

      {!!clips?.length && (
        <div className="clips-layout">
          <aside className="clips-nav">
            {list.map((c, i) => (
              <a key={c.id} href={`#clip-${c.id}`} className="clips-nav-item">
                <span className="clips-nav-n">{i + 1}</span>
                <span className="ellipsis small">{c.meta.title}</span>
              </a>
            ))}
          </aside>
          <div className="col" style={{ gap: 12, minWidth: 0 }}>
            <div className="clips-bar">
              <button className="btn ghost sm" onClick={() => setSel(sel.length === list.length ? [] : list.map((c) => c.id))}>{sel.length === list.length ? <CheckSquare size={15} /> : <Box size={15} />} Selecionar todos <span className="badge">{sel.length}</span></button>
              <button className="btn sm" onClick={() => bulk('post')}><Send size={14} /> Agendar</button>
              <button className="btn sm" onClick={() => download()}><Download size={14} /> Baixar</button>
              <button className="btn sm" onClick={() => bulk('export')}><RefreshCcw size={14} /> Exportar</button>
              <button className="btn ghost sm danger" onClick={() => bulk('delete')}><Trash2 size={14} /> Excluir</button>
              <span className="spacer" />
              <select className="select sm" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as 'score' | 'time')}>
                <option value="score">Maior nota</option>
                <option value="time">Ordem no vídeo</option>
              </select>
            </div>
            {list.map((c, i) => {
              const on = sel.includes(c.id);
              const live = c.job && c.job.status !== 'failed' ? jobs[c.job.id] ?? c.job : null;
              return (
                <article key={c.id} id={`clip-${c.id}`} className={`clip-card ${on ? 'on' : ''}`}>
                  <div className="clip-side">
                    <input type="checkbox" checked={on} onChange={() => setSel(on ? sel.filter((x) => x !== c.id) : [...sel, c.id])} aria-label="Selecionar corte" />
                    <b className="faint">#{i + 1}</b>
                  </div>
                  <div className={`clip-video fmt-${c.format.replace(':', 'x')}`}>
                    {c.export ? <video src={`/api/exports/${c.export.id}/file`} controls preload="metadata" /> : <video src={`${media.proxy(asset.id)}#t=${c.meta.in.toFixed(1)},${c.meta.out.toFixed(1)}`} controls preload="metadata" />}
                    <span className="clip-res">{c.export ? (c.export.current ? 'Exportado' : 'Desatualizado') : 'Prévia do trecho'}</span>
                  </div>
                  <div className="col" style={{ gap: 8, minWidth: 0, flex: 1 }}>
                    <h3 style={{ margin: 0 }}>{c.meta.title}</h3>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {c.meta.score != null && <span className="clip-score">{(c.meta.score / 10).toFixed(1).replace('.', ',')}<small>/10</small></span>}
                      <span className="spacer" />
                      <button className="btn sm" disabled={!c.export} title={c.export ? '' : 'Exporte antes'} onClick={() => bulk('post', {}, [c.id])}><Send size={14} /> Publicar</button>
                      <button className="btn sm" disabled={!c.export} onClick={() => download([c.id])}><Download size={14} /> Baixar</button>
                      <button className="btn ghost sm icon" title="Editar no editor" onClick={() => nav(`/editor/${c.id}`)}><Pencil size={14} /></button>
                      <button className="btn ghost sm icon" title="Exportar de novo" onClick={() => bulk('export', {}, [c.id])}><RefreshCcw size={14} /></button>
                      <button className="btn ghost sm icon danger" title="Excluir corte" onClick={() => bulk('delete', {}, [c.id])}><Trash2 size={14} /></button>
                    </div>
                    {live && <div className="col" style={{ gap: 2 }}><Progress value={live.progress} indeterminate={live.status === 'queued'} /><span className="faint small">{live.status === 'queued' ? 'Na fila para exportar' : live.message}</span></div>}
                    {c.job?.status === 'failed' && <span className="small" style={{ color: 'var(--danger)' }}>{c.job.error}</span>}
                    <div className="clip-text small">
                      <span className="faint">[{mmss(c.meta.in)} – {mmss(c.meta.out)}] · {Math.round(c.duration)} s</span>
                      <p>{c.meta.text ?? c.meta.hook}</p>
                      {!!c.meta.keywords?.length && <span className="faint">Destaques: {c.meta.keywords.join(', ')}</span>}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <aside className="clips-tools" aria-label="Ajustes para os cortes selecionados">
            <span className="faint" style={{ fontSize: 10, textAlign: 'center' }}>{sel.length ? `${sel.length} selec.` : 'Selecione'}</span>
            <ToolMenu icon={<Smartphone size={18} />} label="Formato" items={[['9:16', () => bulk('apply', { format: '9:16' })], ['1:1', () => bulk('apply', { format: '1:1' })], ['16:9', () => bulk('apply', { format: '16:9' })]]} />
            <button className="clips-tool" onClick={() => bulk('apply', { edit: { type: 'remove_pauses' } })}><VolumeX size={18} /><span>Remover silêncio</span></button>
            <ToolMenu icon={<Captions size={18} />} label="Legenda" items={[['Animada', () => bulk('apply', { edit: { type: 'captions', preset: 'bounce', uppercase: true } })], ['Destaque', () => bulk('apply', { edit: { type: 'captions', preset: 'highlight', uppercase: true } })], ['Pop discreta', () => bulk('apply', { edit: { type: 'captions', preset: 'pop', uppercase: false } })], ['Clássica', () => bulk('apply', { edit: { type: 'captions', preset: 'classic' } })]]} />
            <ToolMenu icon={<Palette size={18} />} label="Filtro" items={[['Podcast', () => bulk('apply', { edit: { type: 'filter', preset: 'podcast' } })], ['Cinema', () => bulk('apply', { edit: { type: 'filter', preset: 'cinema' } })], ['Vívido', () => bulk('apply', { edit: { type: 'filter', preset: 'vivido' } })], ['Quente', () => bulk('apply', { edit: { type: 'filter', preset: 'quente' } })], ['Original', () => bulk('apply', { edit: { type: 'filter', preset: 'none' } })]]} />
            <button className="clips-tool" onClick={() => bulk('apply', { edit: { type: 'dynamic_zoom' } })}><Wand2 size={18} /><span>Zoom dinâmico</span></button>
            <button className="clips-tool" onClick={() => bulk('apply', { edit: { type: 'denoise', level: 'light' } })}><Mic size={18} /><span>Limpar áudio</span></button>
          </aside>
        </div>
      )}
    </>
  );
}

function ToolMenu({ icon, label, items }: { icon: React.ReactNode; label: string; items: readonly (readonly [string, () => void])[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="clips-tool" onClick={() => setOpen(!open)}>{icon}<span>{label}</span></button>
      {open && (
        <div className="clips-menu" onMouseLeave={() => setOpen(false)}>
          {items.map(([l, fn]) => <button key={l} onClick={() => { setOpen(false); fn(); }}>{l}</button>)}
        </div>
      )}
    </div>
  );
}
