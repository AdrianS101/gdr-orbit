import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, CalendarDays, Clapperboard, Download, Eye, Plus, Sparkles, BarChart3 } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { fmtBytes, fmtDuration, fmtRelative, PROJECT_STATUS } from '../lib/format.ts';
import { Empty } from '../components/ui.tsx';
import { AreaChart, KpiCard } from '../components/AreaChart.tsx';
import { Heart, Send, MessageSquare, TrendingUp } from 'lucide-react';
import { JobRow } from '../components/Shell.tsx';
import type { Job, ProjectSummary } from '../../../shared/types.ts';

interface HomeData {
  projects: ProjectSummary[];
  failed: Job[];
  active: Job[];
  exports: { id: string; projectId: string; projectName: string; file: string; size: number; createdAt: string }[];
  brands: { id: string; name: string; missing: string[] }[];
  review: ProjectSummary[];
  ai: string | null;
  stats?: {
    kpis: Record<'views' | 'interactions' | 'posts' | 'reach', { cur: number | null; prev: number | null }>;
    series: { day: string; views: number; posts: number }[];
    top: { id: string; caption: string; thumb: string | null; permalink: string | null; network: string; account: string; views: number }[];
    scheduled: number;
    pending: number;
    dms: number;
    synced: boolean;
  };
}

export function HomePage() {
  const { scope, brands, brandsLoaded, jobs } = useApp();
  const [data, setData] = useState<HomeData | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const nav = useNavigate();

  useEffect(() => {
    const ctrl = new AbortController();
    api.get<HomeData>(`/api/home${scope !== 'all' ? `?brandId=${scope}` : ''}`, { signal: ctrl.signal }).then(setData, showError);
    return () => ctrl.abort();
  }, [scope, Object.values(jobs).filter((j) => j.status === 'done' || j.status === 'failed').length]);

  const brand = brands.find((b) => b.id === scope);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  if (brandsLoaded && !brands.length) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>{greet}! Vamos começar.</h1>
            <p>O GDR Digital organiza cada cliente em um espaço próprio. Cadastre a primeira marca para importar vídeos e editar.</p>
          </div>
        </div>
        <Empty icon={<Building2 size={36} />} title="Nenhuma marca cadastrada" action={<button className="btn primary" onClick={() => nav('/marcas?nova=1')}><Plus size={16} /> Cadastrar marca</button>}>
          Comece pela GDR ou por um cliente. Você pode preencher o perfil completo depois.
        </Empty>
      </>
    );
  }

  const inProgress = data?.projects.filter((p) => p.status === 'editing' || p.status === 'draft') ?? [];
  const activeJobs = Object.values(jobs).filter((j) => (j.status === 'running' || j.status === 'queued') && (scope === 'all' || j.brandId === scope));
  const failed = data?.failed.filter((f) => !hidden.has(f.id) && jobs[f.id]?.status !== 'done' && jobs[f.id]?.status !== 'queued') ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greet}!</h1>
          <p>{brand ? `Visão de ${brand.name}` : 'Visão geral da operação'} — o que precisa da sua atenção.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => nav('/biblioteca')}>Importar mídia</button>
          <button className="btn primary" onClick={() => nav('/projetos?novo=1')}>
            <Plus size={16} /> Novo projeto
          </button>
        </div>
      </div>

      {data && !data.ai && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <Sparkles size={18} color="var(--warning)" />
          <div>
            <div className="title">IA ainda não conectada</div>
            <span className="muted">A geração de texto do post precisa de um provedor de IA. </span>
            <Link to="/configuracoes" style={{ color: 'var(--accent)', fontWeight: 600 }}>Configurar agora</Link>
          </div>
        </div>
      )}

      {data?.stats && (
        <section className="dash">
          <div className="dash-kpis">
            <KpiCard label="Visualizações" icon={<Eye size={15} />} {...data.stats.kpis.views} />
            <KpiCard label="Alcance" icon={<TrendingUp size={15} />} {...data.stats.kpis.reach} />
            <KpiCard label="Interações" icon={<Heart size={15} />} {...data.stats.kpis.interactions} />
            <KpiCard label="Posts publicados" icon={<Clapperboard size={15} />} {...data.stats.kpis.posts} />
          </div>
          <div className="dash-main">
            <div className="dash-chart">
              <div className="row">
                <b>Visualizações dos posts por dia de publicação</b>
                <span className="spacer" />
                <span className="faint small">últimos 30 dias · dados da Meta</span>
              </div>
              {data.stats.synced ? (
                <AreaChart label="Visualizações por dia" points={data.stats.series.map((p) => ({ x: p.day.slice(8, 10) + '/' + p.day.slice(5, 7), y: p.views }))} format={(v) => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(Math.round(v)))} />
              ) : (
                <div className="dash-empty">Sem métricas sincronizadas ainda. Conecte os perfis e clique em "Atualizar dados" em <Link to="/resultados" style={{ color: 'var(--accent)' }}>Resultados</Link>.</div>
              )}
            </div>
            <div className="dash-side">
              <Link to="/conteudo" className="mini-stat"><CalendarDays size={16} /><span><b>{data.stats.scheduled}</b> posts agendados</span></Link>
              <Link to="/caixa-de-entrada" className="mini-stat"><MessageSquare size={16} /><span><b>{data.stats.pending}</b> conversas esperando você</span></Link>
              <Link to="/automacoes" className="mini-stat"><Send size={16} /><span><b>{data.stats.dms}</b> DMs automáticas (30 dias)</span></Link>
              <div className="dash-top">
                <span className="label">Top conteúdos</span>
                {!data.stats.top.length && <span className="faint small">Aparece depois da sincronização.</span>}
                {data.stats.top.map((t, i) => (
                  <a key={t.id} className="top-line" href={t.permalink ?? undefined} target="_blank" rel="noreferrer">
                    <b className="faint">{i + 1}</b>
                    <span className="top-thumb">{t.thumb && <img src={t.thumb} alt="" loading="lazy" />}</span>
                    <span className="ellipsis small" style={{ flex: 1 }}>{t.caption || '(sem legenda)'}</span>
                    <b className="small">{t.views.toLocaleString('pt-BR')}</b>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="grid cols-2">
        {failed.length > 0 && (
          <section className="card" style={{ borderColor: 'rgba(239,68,68,.35)' }}>
            <h2 className="row">
              <AlertTriangle size={16} color="var(--danger)" /> Falhas que precisam de atenção
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => api.post('/api/jobs/dismiss-failed', scope !== 'all' ? { brandId: scope } : {}).then(() => { failed.forEach((j) => useApp.getState().removeJob(j.id)); setHidden(new Set(failed.map((j) => j.id))); }, showError)}>Limpar todos</button>
            </h2>
            {failed.map((j) => (
              <JobRow key={j.id} j={jobs[j.id] ?? j} onDismissed={() => setHidden((h) => new Set([...h, j.id]))} />
            ))}
          </section>
        )}

        {activeJobs.length > 0 && (
          <section className="card">
            <h2>Processando agora</h2>
            {activeJobs.map((j) => (
              <JobRow key={j.id} j={j} />
            ))}
          </section>
        )}

        <section className="card">
          <h2 className="row">
            <Eye size={16} /> Revisões pendentes
          </h2>
          {data?.review.length ? (
            data.review.map((p) => <ProjectLine key={p.id} p={p} />)
          ) : (
            <p className="muted small">Nada aguardando revisão. Marque um projeto como "Em revisão" no editor quando ele estiver pronto para aprovação.</p>
          )}
        </section>

        <section className="card">
          <h2 className="row">
            <Clapperboard size={16} /> Projetos em andamento
          </h2>
          {inProgress.length ? (
            inProgress.slice(0, 6).map((p) => <ProjectLine key={p.id} p={p} />)
          ) : (
            <p className="muted small">
              Nenhum projeto em andamento. <Link to="/projetos?novo=1" style={{ color: 'var(--accent)' }}>Criar projeto</Link>
            </p>
          )}
        </section>

        <section className="card">
          <h2 className="row">
            <CalendarDays size={16} /> Próximas publicações
          </h2>
          <p className="muted small">O calendário e o agendamento chegam na Etapa 3. Por enquanto, os vídeos exportados e os textos gerados ficam guardados em cada projeto.</p>
        </section>

        <section className="card">
          <h2 className="row">
            <BarChart3 size={16} /> Resultados relevantes
          </h2>
          <p className="muted small">Sem dados de métricas: nenhuma rede social está conectada. A coleta de métricas chega na Etapa 4.</p>
        </section>

        {data && data.exports.length > 0 && (
          <section className="card">
            <h2 className="row">
              <Download size={16} /> Exportações recentes
            </h2>
            <div className="list">
              {data.exports.map((e) => (
                <div className="list-item" key={e.id}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{e.projectName}</div>
                    <div className="faint small">
                      {fmtBytes(e.size)} · {fmtRelative(e.createdAt)}
                    </div>
                  </div>
                  <a className="btn sm" href={`/api/exports/${e.id}/file?download=1`}>
                    <Download size={14} /> Baixar
                  </a>
                </div>
              ))}
            </div>
          </section>
        )}

        {data && data.brands.some((b) => b.missing.length) && (
          <section className="card">
            <h2 className="row">
              <Building2 size={16} /> Perfis de marca incompletos
            </h2>
            <p className="muted small" style={{ marginTop: -6 }}>A IA usa o perfil da marca. Campos vazios não são inventados — preencha para textos mais precisos.</p>
            <div className="list">
              {data.brands
                .filter((b) => b.missing.length)
                .map((b) => (
                  <Link to={`/marcas/${b.id}`} className="list-item" key={b.id}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{b.name}</div>
                      <div className="faint small ellipsis">Falta: {b.missing.join(', ')}</div>
                    </div>
                    <span className="badge warning">{b.missing.length} campos</span>
                  </Link>
                ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function ProjectLine({ p }: { p: ProjectSummary }) {
  const st = PROJECT_STATUS[p.status];
  const brands = useApp((s) => s.brands);
  return (
    <Link to={`/editor/${p.id}`} className="list-item">
      <div className="thumb" style={{ width: 64, aspectRatio: '1', flex: 'none' }}>
        {p.thumbAssetId ? <img src={media.poster(p.thumbAssetId)} alt="" loading="lazy" /> : <Clapperboard size={18} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ellipsis" style={{ fontWeight: 600 }}>{p.name}</div>
        <div className="faint small">
          {brands.find((b) => b.id === p.brandId)?.name} · {p.format.preset} · {fmtDuration(p.duration)} · {fmtRelative(p.updatedAt)}
        </div>
      </div>
      <span className={`badge ${st.tone}`}>{st.label}</span>
    </Link>
  );
}
