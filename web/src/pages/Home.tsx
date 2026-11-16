import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, CalendarDays, Clapperboard, Download, Eye, Plus, Sparkles, LayoutDashboard, ChevronLeft, ChevronRight, CheckCircle2, Clock, CircleAlert, FileClock } from 'lucide-react';
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
  month?: { key: string; total: number; published: number; scheduled: number; pending: number; failed: number; late: number; upcoming: { id: string; brandId: string; type: string; caption: string; status: string; scheduledAt: string }[] };
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
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const monthKey = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
  const nav = useNavigate();

  useEffect(() => {
    const ctrl = new AbortController();
    api.get<HomeData>(`/api/home?month=${monthKey}${scope !== 'all' ? `&brandId=${scope}` : ''}`, { signal: ctrl.signal }).then(setData, showError);
    return () => ctrl.abort();
  }, [scope, monthKey, Object.values(jobs).filter((j) => j.status === 'done' || j.status === 'failed').length]);

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
      {(() => {
        const m = data?.month;
        const pct = m && m.total ? Math.round((m.published / m.total) * 100) : 0;
        const isNow = monthKey === `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const phrase = !m || !m.total ? 'Nenhum post planejado neste mês ainda. Que tal montar o calendário?' : pct >= 100 ? 'Mês fechado com tudo publicado!' : m.late ? `${m.late} post${m.late > 1 ? 's passaram' : ' passou'} da data sem publicar — vale olhar.` : pct >= 60 ? 'Bom ritmo, vamos fechar o mês com tudo!' : 'Mês em andamento, siga o calendário.';
        return (
          <section className="hero">
            <div className="hero-main">
              <span className="eyebrow-chip"><LayoutDashboard size={12} /> Painel · {brand ? brand.name : 'Toda a operação'}</span>
              <h1 className="hero-title">{greet}!</h1>
              <p className="hero-sub">{phrase}</p>
              <div className="row wrap" style={{ gap: 10 }}>
                <div className="month-pick">
                  <button className="btn ghost sm icon" aria-label="Mês anterior" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
                  <b>{month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</b>
                  <button className="btn ghost sm icon" aria-label="Próximo mês" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
                </div>
                {!isNow && <button className="btn ghost sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Mês atual</button>}
                <span className="spacer" />
                <button className="btn" onClick={() => nav('/biblioteca')}>Importar mídia</button>
                <button className="btn primary" onClick={() => nav('/projetos?novo=1')}><Plus size={16} /> Novo projeto</button>
              </div>
            </div>
            <div className="ring" style={{ ['--p' as string]: pct }} title="Posts do mês já publicados">
              <div><b>{pct}%</b><span>publicado</span><small>{m?.published ?? 0} de {m?.total ?? 0}</small></div>
            </div>
          </section>
        );
      })()}
      {data?.month && (
        <div className="tiles">
          <Link to="/conteudo" className="tile"><span className="tile-ico t-accent"><CalendarDays size={16} /></span><b>{data.month.total}</b><span>posts no mês</span></Link>
          <Link to="/conteudo" className="tile"><span className="tile-ico t-success"><CheckCircle2 size={16} /></span><b>{data.month.published}</b><span>publicados</span></Link>
          <Link to="/conteudo" className="tile"><span className="tile-ico t-info"><Clock size={16} /></span><b>{data.month.scheduled}</b><span>agendados</span></Link>
          <Link to="/conteudo" className="tile"><span className="tile-ico t-warning"><FileClock size={16} /></span><b>{data.month.pending}</b><span>em preparo ou revisão</span></Link>
          <Link to="/conteudo" className={`tile ${data.month.late + data.month.failed ? 'alert-tile' : ''}`}><span className="tile-ico t-danger"><CircleAlert size={16} /></span><b>{data.month.late + data.month.failed}</b><span>atrasados ou com falha</span></Link>
        </div>
      )}

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
          {data?.month?.upcoming.length ? (
            <div className="list">
              {data.month.upcoming.map((p) => (
                <Link to="/conteudo" className="list-item" key={p.id}>
                  <span className="tile-ico t-accent">{p.type === 'video' ? <Clapperboard size={14} /> : <CalendarDays size={14} />}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{p.caption || '(sem legenda)'}</div>
                    <div className="faint small">{new Date(p.scheduledAt).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{scope === 'all' ? ` · ${brands.find((b) => b.id === p.brandId)?.name ?? ''}` : ''}</div>
                  </div>
                  <span className={`badge ${p.status === 'scheduled' ? 'accent' : 'warning'}`}>{p.status === 'scheduled' ? 'Agendado' : 'Não agendado'}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted small">Nada programado para o resto deste mês. <Link to="/conteudo" style={{ color: 'var(--accent)' }}>Abrir o calendário</Link></p>
          )}
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
