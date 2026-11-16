// Relatório padrão GDR: o Claude lê os dados reais do período e devolve o relatório pronto no modelo da agência.
import { useEffect, useState } from 'react';
import { FileText, Sparkles, ExternalLink, Trash2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { Progress } from '../components/ui.tsx';
import { fmtDateTime } from '../lib/format.ts';

interface Report { id: string; title: string; since: string; until: string; model: string | null; createdAt: string }

export function ReportsPanel({ brandId, since, until }: { brandId: string; since: string; until: string }) {
  const [list, setList] = useState<Report[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useApp((s) => (jobId ? s.jobs[jobId] : Object.values(s.jobs).find((j) => j.type === 'report' && j.brandId === brandId && (j.status === 'running' || j.status === 'queued'))));
  const load = () => api.get<Report[]>(`/api/reports?brandId=${brandId}`).then(setList, showError);
  useEffect(() => { load(); }, [brandId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onJob((j) => {
    if (j.type !== 'report' || j.brandId !== brandId) return;
    if (j.status === 'done') {
      load();
      useApp.getState().toast({ kind: 'success', title: 'Relatório pronto', hint: 'Abra para revisar, inserir os prints e salvar em PDF.' });
    }
  }), [brandId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Do início do dia "De" até o fim do dia "Até" (horário local).
  const start = new Date(since + 'T00:00:00');
  const end = new Date(until + 'T00:00:00');
  end.setDate(end.getDate() + 1);
  const days = Math.round((end.getTime() - start.getTime()) / 86400_000);
  const generate = () => api.post<{ jobId: string }>('/api/reports/generate', { brandId, since: start.toISOString(), until: end.toISOString() }).then((r) => setJobId(r.jobId), showError);
  const running = job && (job.status === 'running' || job.status === 'queued');
  const open = (id: string) => window.open(`/api/reports/${id}/view`, '_blank', 'noopener');

  return (
    <div className="col" style={{ gap: 16 }}>
      <section className="card col" style={{ gap: 12 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <span className="tile-ico t-accent"><FileText size={16} /></span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2 style={{ margin: 0 }}>Relatório de resultados no modelo GDR</h2>
            <span className="muted small">
              Período escolhido acima: {new Date(since + 'T12:00:00').toLocaleDateString('pt-BR')} a {new Date(until + 'T12:00:00').toLocaleDateString('pt-BR')} ({days} dias), comparado com os 2 períodos anteriores de mesma duração.
            </span>
          </div>
          <button className="btn primary" disabled={!!running} onClick={generate}><Sparkles size={16} /> {running ? 'Gerando…' : 'Gerar relatório com o Claude'}</button>
        </div>
        <span className="faint small">Os números vêm só da Meta (e das planilhas importadas); o Claude lê esses dados, escolhe os destaques e escreve os textos, inclusive os pontos negativos. Antes de enviar ao cliente, abra o relatório para revisar, editar textos, inserir os prints de antes/depois e salvar em PDF.</span>
        {running && (
          <div className="col" style={{ gap: 4 }}>
            <Progress value={job!.progress} indeterminate={job!.status === 'queued'} />
            <span className="faint small">{job!.message || 'Na fila'}</span>
          </div>
        )}
        {job?.status === 'failed' && <div className="alert danger small">{job.error}</div>}
      </section>

      <section className="card col" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }}>Relatórios gerados</h2>
        {list && !list.length && <span className="muted small">Nenhum relatório desta marca ainda.</span>}
        <div className="list">
          {list?.map((r) => (
            <div key={r.id} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 600 }}>{r.title}</div>
                <div className="faint small">Gerado em {fmtDateTime(r.createdAt)}{r.model ? ` · ${r.model}` : ''}</div>
              </div>
              <button className="btn sm" onClick={() => open(r.id)}><ExternalLink size={14} /> Abrir</button>
              <button className="btn ghost sm icon" title="Excluir" aria-label="Excluir relatório" onClick={() => api.del(`/api/reports/${r.id}`).then(load, showError)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
