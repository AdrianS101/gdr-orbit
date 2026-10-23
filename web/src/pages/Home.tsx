import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, CalendarDays, Clapperboard, Download, Eye, Plus, Sparkles, BarChart3 } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { fmtBytes, fmtDuration, fmtRelative, PROJECT_STATUS } from '../lib/format.ts';
import { Empty } from '../components/ui.tsx';
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
}

export function HomePage() {
  const { scope, brands, brandsLoaded, jobs } = useApp();
  const [data, setData] = useState<HomeData | null>(null);
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
            <p>O GDR Orbit organiza cada cliente em um espaço próprio. Cadastre a primeira marca para importar vídeos e editar.</p>
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
  const failed = data?.failed.filter((f) => jobs[f.id]?.status !== 'done' && jobs[f.id]?.status !== 'queued') ?? [];

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

      <div className="grid cols-2">
        {failed.length > 0 && (
          <section className="card" style={{ borderColor: 'rgba(239,68,68,.35)' }}>
            <h2 className="row">
              <AlertTriangle size={16} color="var(--danger)" /> Falhas que precisam de atenção
            </h2>
            {failed.map((j) => (
              <JobRow key={j.id} j={jobs[j.id] ?? j} />
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
