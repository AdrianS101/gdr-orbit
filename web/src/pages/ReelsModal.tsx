// Vários Reels a partir de uma entrevista: a IA sugere trechos completos (sempre em fronteiras de frase), você revisa e cria os projetos.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Scissors, Zap } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { Field, Modal, Progress, Spinner } from '../components/ui.tsx';
import { fmtTime } from '../../../shared/timeline.ts';
import type { Asset } from '../../../shared/types.ts';

interface Seg { in: number; out: number; title: string; hook: string; why: string; text: string; warning: string | null; score?: number; structure?: { inicio: string; meio: string; fim: string }; hookIn?: number | null; hookOut?: number | null; hookText?: string | null }

export function ReelsModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const nav = useNavigate();
  const jobs = useApp((s) => s.jobs);
  const [transcribed, setTranscribed] = useState(asset.transcriptStatus === 'ready');
  const [jobId, setJobId] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [minDur, setMinDur] = useState(20);
  const [maxDur, setMaxDur] = useState(60);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [segs, setSegs] = useState<Seg[] | null>(null);
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState<boolean[]>([]);
  const [opts, setOpts] = useState({ removePauses: true, captions: true, logo: true, hookTitle: true });
  const [viral, setViral] = useState(true);
  const [autoExport, setAutoExport] = useState(true);
  const [stage, setStage] = useState('');

  useEffect(() => onJob((j) => j.id === jobId && j.status === 'done' && setTranscribed(true)), [jobId]);
  const job = jobId ? jobs[jobId] : null;

  const transcribe = () => api.post<{ jobId: string }>(`/api/assets/${asset.id}/transcribe`, {}).then((r) => setJobId(r.jobId), showError);
  const suggest = () => {
    setBusy(true);
    api
      .post<{ segments: Seg[]; note: string }>(`/api/assets/${asset.id}/reels/suggest`, { count, minDur, maxDur, notes, viral })
      .then((r) => {
        setSegs(r.segments);
        setNote(r.note);
        setChosen(r.segments.map(() => true));
      }, showError)
      .finally(() => setBusy(false));
  };
  const finish = (r: { created: { id: string; name: string; warnings: string[]; jobId?: string | null }[] }) => {
    const warn = r.created.flatMap((c) => c.warnings);
    const exp = r.created.filter((c) => c.jobId).length;
    useApp.getState().toast({ kind: 'success', title: `${r.created.length} corte(s) criado(s)${exp ? ` · ${exp} exportando` : ''}`, hint: warn.length ? `Avisos: ${Array.from(new Set(warn)).join(' ')}` : exp ? 'Acompanhe em Processamentos; os MP4 aparecem em cada projeto.' : 'Revise cada um no editor antes de exportar.' });
    onClose();
    nav('/projetos');
  };
  /** 1 clique: a IA escolhe os melhores cortes, cria os projetos com o estilo viral e já exporta. */
  const oneClick = async () => {
    setBusy(true);
    try {
      setStage('Lendo a conversa e escolhendo os melhores trechos…');
      const sug = await api.post<{ segments: Seg[]; note: string }>(`/api/assets/${asset.id}/reels/suggest`, { count, minDur, maxDur, notes, viral: true });
      if (!sug.segments.length) {
        setNote(sug.note || 'Nenhum trecho completo encontrado.');
        return;
      }
      setStage(`Montando ${sug.segments.length} corte(s) com legenda, filtro e ritmo…`);
      finish(await api.post(`/api/assets/${asset.id}/reels/create`, { segments: sug.segments, ...opts, viral: true, autoExport }));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
      setStage('');
    }
  };
  const create = () => {
    const picked = (segs ?? []).filter((_, i) => chosen[i]);
    setBusy(true);
    api
      .post<{ created: { id: string; name: string; warnings: string[]; jobId?: string | null }[] }>(`/api/assets/${asset.id}/reels/create`, { segments: picked, ...opts, viral, autoExport })
      .then((r) => {
        finish(r);
      }, showError)
      .finally(() => setBusy(false));
  };
  const n = chosen.filter(Boolean).length;
  const upd = (i: number, p: Partial<Seg>) => setSegs((s) => s!.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Modal
      wide
      title={`Reels a partir de "${asset.name}"`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancelar</button>
          {segs && <button className="btn primary" disabled={!n || busy} onClick={create}><Scissors size={16} /> Criar {n} projeto(s)</button>}
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {!transcribed ? (
          <div className="col" style={{ gap: 8 }}>
            <p className="small">Os cortes são escolhidos pela fala. Primeiro é preciso transcrever o vídeo (local, sem custo; leva mais ou menos a duração do vídeo).</p>
            {job ? <><Progress value={job.progress} indeterminate={job.status === 'queued'} /><span className="faint small">{job.message}</span>{job.status === 'failed' && <span className="small" style={{ color: 'var(--danger)' }}>{job.error}</span>}</> : <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={transcribe}>Transcrever agora</button>}
          </div>
        ) : (
          <>
            <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
              <Field label="Quantos cortes"><input className="input sm" type="number" min={1} max={6} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 80 }} /></Field>
              <Field label="Duração mínima (s)"><input className="input sm" type="number" min={10} value={minDur} onChange={(e) => setMinDur(Number(e.target.value))} style={{ width: 90 }} /></Field>
              <Field label="Duração máxima (s)"><input className="input sm" type="number" min={15} max={180} value={maxDur} onChange={(e) => setMaxDur(Number(e.target.value))} style={{ width: 90 }} /></Field>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Field label="Orientação (opcional)"><input className="input sm" placeholder="Ex.: foque nas dicas práticas sobre anúncios" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              </div>
              <button className="btn" disabled={busy} onClick={suggest}>{busy && !segs && !stage ? <Spinner /> : <Sparkles size={16} />} {segs ? 'Sugerir de novo' : 'Revisar antes'}</button>
              <button className="btn primary" disabled={busy} onClick={oneClick} title="A IA escolhe, monta e exporta os cortes sozinha">{stage ? <Spinner /> : <Zap size={16} />} Gerar cortes virais (1 clique)</button>
            </div>
            <div className="row wrap small" style={{ gap: 14 }}>
              <label className="row"><input type="checkbox" checked={viral} onChange={(e) => setViral(e.target.checked)} /> Estilo viral (gancho de abertura, legenda grande, filtro cinematográfico, cortes com zoom)</label>
              <label className="row"><input type="checkbox" checked={autoExport} onChange={(e) => setAutoExport(e.target.checked)} /> Já exportar os MP4</label>
              {stage && <span className="faint">{stage}</span>}
            </div>
            <p className="faint small" style={{ margin: 0 }}>A IA só escolhe trechos que começam e terminam em fim de frase; o título na tela precisa ser fiel ao que é dito. Revise antes de criar.</p>
          </>
        )}
        {note && <div className="alert info small">{note}</div>}
        {segs && !segs.length && <div className="alert warning small">Nenhum trecho completo encontrado com essa duração. Diminua a duração mínima ou peça menos cortes.</div>}
        {segs?.map((s, i) => (
          <div key={i} className="card row wrap" style={{ gap: 12, alignItems: 'flex-start', background: 'var(--surface-2)', opacity: chosen[i] ? 1 : 0.55 }}>
            <video src={`${media.proxy(asset.id)}#t=${s.in.toFixed(2)},${s.out.toFixed(2)}`} controls preload="metadata" style={{ width: 120, aspectRatio: '9/16', background: '#000', borderRadius: 8, objectFit: 'cover' }} />
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 220 }}>
              <label className="row small">
                <input type="checkbox" checked={chosen[i]} onChange={(e) => setChosen((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} />
                <b>{fmtTime(s.in)} → {fmtTime(s.out)}</b> <span className="faint">({Math.round(s.out - s.in)} s)</span>
              </label>
              <Field label="Nome do projeto"><input className="input sm" value={s.title} onChange={(e) => upd(i, { title: e.target.value })} /></Field>
              <Field label="Título na tela (3 primeiros segundos)"><input className="input sm" value={s.hook} onChange={(e) => upd(i, { hook: e.target.value })} /></Field>
              {typeof s.score === 'number' && <span className="badge accent" style={{ alignSelf: 'flex-start' }}>Retenção estimada pela IA: {s.score}/100</span>}
              {s.hookText && <span className="small"><b>Abre com:</b> “{s.hookText}”</span>}
              {s.structure && <span className="small faint"><b>Início:</b> {s.structure.inicio} · <b>Meio:</b> {s.structure.meio} · <b>Fim:</b> {s.structure.fim}</span>}
              <span className="small faint">Por quê: {s.why}</span>
              {s.warning && <span className="small" style={{ color: 'var(--warning)' }}>{s.warning}</span>}
              <details className="small"><summary>Fala do trecho</summary><p style={{ whiteSpace: 'pre-wrap' }}>{s.text}</p></details>
            </div>
          </div>
        ))}
        {segs && (
          <div className="row wrap small" style={{ gap: 14 }}>
            <b>Em cada projeto:</b>
            {([['removePauses', 'Remover pausas'], ['captions', 'Legendas animadas'], ['logo', 'Logo da marca'], ['hookTitle', 'Título de abertura']] as const).map(([k, l]) => (
              <label key={k} className="row"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {l}</label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
