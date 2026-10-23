// Ritmo de edição a partir de um vídeo de referência: mede os cortes do vídeo escolhido e aplica um ritmo parecido.
import { useEffect, useMemo, useState } from 'react';
import { Gauge, Activity } from 'lucide-react';
import { useEditor } from './store.ts';
import { updateTimeline } from './actions.ts';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Field, Spinner } from '../components/ui.tsx';
import { projectRhythm, type RhythmProfile } from '../../../shared/studio.ts';
import { applyAction } from '../../../shared/edit-actions.ts';

type Saved = RhythmProfile & { assetId: string; name: string; measuredAt: string; method: string };
const n1 = (v: number | null) => (v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));

function Stats({ p }: { p: RhythmProfile }) {
  return (
    <div className="kpis">
      <div className="kpi"><span className="faint small">Plano médio</span><b>{n1(p.avgShot)} s</b></div>
      <div className="kpi"><span className="faint small">Plano mediano</span><b>{n1(p.medianShot)} s</b></div>
      <div className="kpi"><span className="faint small">Cortes/min</span><b>{n1(p.cutsPerMinute)}</b></div>
      <div className="kpi"><span className="faint small">1º corte</span><b>{p.firstCut == null ? '—' : `${n1(p.firstCut)} s`}</b></div>
      {p.wordsPerMinute != null && <div className="kpi"><span className="faint small">Palavras/min</span><b>{Math.round(p.wordsPerMinute)}</b></div>}
    </div>
  );
}

export function RhythmSection() {
  const timeline = useEditor((s) => s.timeline)!;
  const transcripts = useEditor((s) => s.transcripts);
  const assets = useEditor((s) => s.assets);
  const project = useEditor((s) => s.project)!;
  const [refs, setRefs] = useState<Saved[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState(2.5);
  useEffect(() => {
    api.get<Saved[]>(`/api/brands/${project.brandId}/rhythms`).then(setRefs, () => {});
  }, [project.brandId]);
  const mine = useMemo(() => projectRhythm(timeline, transcripts), [timeline, transcripts]);
  const ref = refs.find((r) => r.assetId === pick);
  useEffect(() => {
    if (ref) setShot(Number(Math.max(0.8, ref.medianShot).toFixed(1)));
  }, [ref?.assetId, ref?.measuredAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const videos = Object.values(assets).filter((a) => a.kind === 'video' && a.status === 'ready');

  const measure = () => {
    if (!pick) return;
    setBusy(true);
    api.post<Saved>(`/api/assets/${pick}/rhythm`).then((r) => setRefs((x) => [...x.filter((y) => y.assetId !== r.assetId), r]), showError).finally(() => setBusy(false));
  };
  const apply = () => {
    const brand = useApp.getState().brands.find((b) => b.id === project.brandId);
    try {
      updateTimeline((tl) => applyAction(tl, { type: 'rhythm', shotLength: shot }, { transcripts, assets, brand: { colors: brand?.profile.colors.map((c) => c.hex) ?? [], logoAssetId: brand?.profile.logoAssetId ?? null } }).timeline, 'Ritmo de referência');
    } catch (e) {
      useApp.getState().toast({ kind: 'error', title: (e as Error).message, hint: 'Diminua o tempo por plano ou junte trechos antes.' });
    }
  };

  return (
    <section className="col" style={{ gap: 10, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div className="label row"><Activity size={14} /> Ritmo de referência</div>
      <p className="faint small" style={{ margin: 0 }}>Envie para a Biblioteca um Reel cujo ritmo você gosta, meça os cortes e aplique um ritmo parecido: o vídeo é dividido nas pausas entre palavras e alterna enquadramento normal/aproximado.</p>
      <Field label="Vídeo de referência">
        <select className="select sm" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Escolha um vídeo da Biblioteca…</option>
          {videos.map((v) => <option key={v.id} value={v.id}>{v.name}{refs.some((r) => r.assetId === v.id) ? ' (medido)' : ''}</option>)}
        </select>
      </Field>
      {pick && <button className="btn sm" disabled={busy} onClick={measure}>{busy ? <Spinner /> : <Gauge size={14} />} {ref ? 'Medir de novo' : 'Medir ritmo'}</button>}
      {ref && (
        <>
          <span className="small"><b>Referência</b> · {ref.shots} planos em {n1(ref.duration)} s</span>
          <Stats p={ref} />
          <span className="faint small">{ref.method}. Cortes muito sutis ou só de zoom podem não ser contados.</span>
        </>
      )}
      <span className="small"><b>Este projeto</b> (cortes, zoom e faixas)</span>
      <Stats p={mine} />
      <Field label={`Tempo por plano: ${n1(shot)} s`}>
        <input type="range" min={0.8} max={8} step={0.1} value={shot} onChange={(e) => setShot(Number(e.target.value))} />
      </Field>
      <button className="btn primary sm" disabled={!timeline.clips.length} onClick={apply}>Aplicar ritmo</button>
      <span className="faint small">Pode desfazer com Ctrl+Z. Funciona melhor com o vídeo transcrito (os cortes caem nas pausas).</span>
    </section>
  );
}
