import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Home, Building2, Clapperboard, FolderOpen, CalendarDays, Inbox, Workflow, BarChart3, Settings, ChevronDown, Check, Activity, X, RotateCcw, LogOut, Layers } from 'lucide-react';
import { useApp, showError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { Progress, OrbitLogo } from './ui.tsx';
import type { Job } from '../../../shared/types.ts';

const NAV = [
  { to: '/', icon: Home, label: 'Início', end: true },
  { to: '/marcas', icon: Building2, label: 'Marcas e clientes' },
  { to: '/projetos', icon: Clapperboard, label: 'Projetos e editor' },
  { to: '/biblioteca', icon: FolderOpen, label: 'Biblioteca' },
  { sep: true },
  { to: '/conteudo', icon: CalendarDays, label: 'Conteúdo e calendário' },
  { to: '/caixa-de-entrada', icon: Inbox, label: 'Caixa de entrada' },
  { to: '/automacoes', icon: Workflow, label: 'Automações' },
  { to: '/resultados', icon: BarChart3, label: 'Resultados' },
] as const;

const MOBILE_NAV = [
  { to: '/', icon: Home, label: 'Início', end: true },
  { to: '/projetos', icon: Clapperboard, label: 'Projetos' },
  { to: '/conteudo', icon: CalendarDays, label: 'Calendário' },
  { to: '/caixa-de-entrada', icon: Inbox, label: 'Mensagens' },
  { to: '/resultados', icon: BarChart3, label: 'Resultados' },
];

export function BrandSwitcher() {
  const { brands, scope, setScope } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const current = brands.find((b) => b.id === scope);
  return (
    <div className="brand-switch" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title="Marca selecionada">
        <BrandAvatar b={current} size={22} />
        <span className="ellipsis" style={{ fontWeight: 600 }}>{current ? current.name : 'Visão geral (todas as marcas)'}</span>
        <span className="spacer" />
        <ChevronDown size={16} className="faint" />
      </button>
      {open && (
        <div className="menu" role="listbox">
          <button className={scope === 'all' ? 'on' : ''} onClick={() => (setScope('all'), setOpen(false))}>
            <BrandAvatar b={null} size={24} />
            <span>
              Visão geral
              <div className="faint small">Toda a operação</div>
            </span>
            <span className="spacer" />
            {scope === 'all' && <Check size={16} />}
          </button>
          {brands.map((b) => (
            <button key={b.id} className={scope === b.id ? 'on' : ''} onClick={() => (setScope(b.id), setOpen(false))}>
              <BrandAvatar b={b} size={24} />
              <span className="ellipsis">{b.name}</span>
              <span className="spacer" />
              {scope === b.id && <Check size={16} />}
            </button>
          ))}
          {!brands.length && <div className="hint">Nenhuma marca cadastrada ainda.</div>}
          <div className="nav-sep" />
          <button onClick={() => (setOpen(false), nav('/marcas?nova=1'))}>+ Nova marca</button>
        </div>
      )}
    </div>
  );
}

const JOB_LABEL: Record<string, string> = { ingest: 'Preparação', transcribe: 'Transcrição', render: 'Exportação', publish: 'Publicação', drive: 'Drive', metrics: 'Métricas' };

export function JobRow({ j, compact }: { j: Job; compact?: boolean }) {
  const removeJob = useApp((s) => s.removeJob);
  const act = async (a: 'cancel' | 'retry' | 'dismiss') => {
    try {
      await api.post(`/api/jobs/${j.id}/${a}`);
      if (a === 'dismiss') removeJob(j.id);
    } catch (e) {
      showError(e);
    }
  };
  return (
    <div className="job">
      <div className="row">
        <span className={`badge ${j.status === 'failed' ? 'danger' : j.status === 'done' ? 'success' : j.status === 'running' ? 'accent' : ''}`}>{JOB_LABEL[j.type] ?? j.type}</span>
        <span className="ellipsis small" style={{ flex: 1 }} title={j.title}>{j.title}</span>
        {(j.status === 'queued' || j.status === 'running') && (
          <button className="btn ghost sm icon" title="Cancelar" onClick={() => act('cancel')}>
            <X size={14} />
          </button>
        )}
        {(j.status === 'failed' || j.status === 'canceled') && (
          <button className="btn ghost sm" title="Tentar novamente" onClick={() => act('retry')}>
            <RotateCcw size={14} /> Tentar de novo
          </button>
        )}
      </div>
      {(j.status === 'queued' || j.status === 'running') && (
        <div style={{ marginTop: 6 }}>
          <Progress value={j.progress} indeterminate={j.status === 'queued'} />
          {!compact && <div className="faint small" style={{ marginTop: 4 }}>{j.message}</div>}
        </div>
      )}
      {j.status === 'failed' && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{j.error}</div>}
    </div>
  );
}

function JobsIndicator() {
  const jobs = useApp((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12), [jobs]);
  const active = list.filter((j) => j.status === 'running' || j.status === 'queued');
  const failed = list.filter((j) => j.status === 'failed');
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn ghost sm" onClick={() => setOpen(!open)} title="Processamentos">
        <Activity size={16} color={active.length ? 'var(--accent)' : undefined} />
        <span className="hide-mobile">{active.length ? `${active.length} em andamento` : failed.length ? `${failed.length} com falha` : 'Processamentos'}</span>
        {failed.length > 0 && <span className="badge danger">{failed.length}</span>}
      </button>
      {open && (
        <div className="menu jobs-pop">
          {!list.length && <div className="hint">Nenhum processamento recente.</div>}
          {list.map((j) => (
            <JobRow key={j.id} j={j} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    location.href = '/';
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brandmark">
          <div className="logo">
            <OrbitLogo />
          </div>
          <div>
            <b>GDR Digital</b>
            <small>GDR Gestão de Resultados</small>
          </div>
        </div>
        {NAV.map((n, i) =>
          'sep' in n ? (
            <div key={i} className="nav-sep" />
          ) : (
            <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <n.icon size={18} />
              <span>{n.label}</span>
              {'soon' in n && <span className="soon">{String((n as { soon?: string }).soon)}</span>}
            </NavLink>
          ),
        )}
        <div className="grow" />
        <NavLink to="/configuracoes" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Settings size={18} />
          <span>Configurações</span>
        </NavLink>
        <button className="nav-item" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={logout}>
          <LogOut size={18} />
          <span>Sair</span>
        </button>
      </aside>
      <div className="main">
        <header className="topbar">
          <BrandSwitcher />
          <span className="spacer" />
          <JobsIndicator />
          <NavLink to="/configuracoes" className="btn ghost sm icon" title="Configurações" style={{ display: 'inline-flex' }}>
            <Settings size={16} />
          </NavLink>
        </header>
        <div className="content">{children}</div>
      </div>
      <nav className="bottom-nav">
        {MOBILE_NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => (isActive ? 'active' : '')}>
            <n.icon size={20} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Foto da marca (perfil conectado ou logo); sem foto, iniciais na cor da marca. */
export function BrandAvatar({ b, size = 24 }: { b: { name: string; avatar?: string | null; profile: { colors: { hex: string }[] } } | null | undefined; size?: number }) {
  const st = { width: size, height: size, minWidth: size };
  if (!b) return <span className="brand-av all" style={st}><Layers size={size * 0.55} /></span>;
  if (b.avatar) return <img className="brand-av" src={b.avatar} alt="" style={st} loading="lazy" />;
  const ini = b.name.split(/s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return <span className="brand-av" style={{ ...st, background: b.profile.colors[0]?.hex ?? 'var(--surface-3)', fontSize: size * 0.4 }}>{ini}</span>;
}
