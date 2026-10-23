import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Undo2, Redo2, History, Download, Check, CloudOff, Loader2, AlertTriangle, Film, Captions, Stamp, Sparkles, RectangleVertical, ShieldCheck, Play, Pause, MessageSquare, SlidersHorizontal, Type, Music } from 'lucide-react';
import { ChatPanel } from './ChatPanel.tsx';
import { EffectsPanel, TextPanel, MusicPanel } from './FxPanels.tsx';
import { useEditor, type PanelTab } from './store.ts';
import { Player } from './Player.tsx';
import { TimelinePanel } from './Timeline.tsx';
import { CaptionsPanel } from './CaptionsPanel.tsx';
import { MediaPanel, ElementsPanel, FormatPanel, Inspector } from './Panels.tsx';
import { PostPanel } from './PostPanel.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { splitAtPlayhead, deleteSelection, duplicateSelection, seekBy } from './actions.ts';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { fmtDateTime, fmtDuration, PROJECT_STATUS } from '../lib/format.ts';
import { Modal, Spinner } from '../components/ui.tsx';
import { fmtTime, timelineDuration } from '../../../shared/timeline.ts';
import '../styles/editor.css';

const TABS: { id: PanelTab; label: string; icon: typeof Film }[] = [
  { id: 'chat', label: 'Chat IA', icon: MessageSquare },
  { id: 'media', label: 'Mídia', icon: Film },
  { id: 'captions', label: 'Legendas', icon: Captions },
  { id: 'effects', label: 'Efeitos', icon: SlidersHorizontal },
  { id: 'text', label: 'Texto', icon: Type },
  { id: 'music', label: 'Música', icon: Music },
  { id: 'elements', label: 'Logo', icon: Stamp },
  { id: 'format', label: 'Formato', icon: RectangleVertical },
  { id: 'post', label: 'Texto do post', icon: Sparkles },
];

function SaveIndicator() {
  const s = useEditor((x) => x.saveState);
  const err = useEditor((x) => x.saveError);
  if (s === 'saved') return <span className="save-ind faint"><Check size={14} /> Salvo</span>;
  if (s === 'saving' || s === 'dirty') return <span className="save-ind faint"><Loader2 size={14} className="spin" /> Salvando…</span>;
  if (s === 'conflict') return <span className="save-ind" style={{ color: 'var(--danger)' }} title={err}><AlertTriangle size={14} /> Conflito</span>;
  return <span className="save-ind" style={{ color: 'var(--warning)' }} title={err}><CloudOff size={14} /> Não salvo — tentando de novo</span>;
}

function VersionsDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const [list, setList] = useState<{ id: string; label: string | null; auto: boolean; createdAt: string; duration: number }[]>([]);
  const [label, setLabel] = useState('');
  const load = () => api.get(`/api/projects/${project.id}/versions`).then(setList, showError);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveVersion = async () => {
    await useEditor.getState().save();
    try {
      await api.post(`/api/projects/${project.id}/versions`, { label });
      setLabel('');
      load();
    } catch (e) {
      showError(e);
    }
  };
  const restore = async (id: string) => {
    try {
      const v = await api.get(`/api/projects/${project.id}/versions/${id}`);
      useEditor.getState().commit(v.timeline, 'Restaurar versão');
      useApp.getState().toast({ kind: 'success', title: 'Versão restaurada', hint: 'Se mudar de ideia, use Desfazer (Ctrl+Z).' });
      onClose();
    } catch (e) {
      showError(e);
    }
  };
  return (
    <Modal title="Histórico de versões" onClose={onClose}>
      <div className="row">
        <input className="input" placeholder="Nome da versão (ex.: enviada ao cliente)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn primary" onClick={saveVersion}>Salvar versão</button>
      </div>
      <div className="faint small">O GDR Digital também guarda versões automáticas a cada 5 minutos de edição.</div>
      <div className="list">
        {list.map((v) => (
          <div key={v.id} className="list-item">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{v.label ?? 'Versão automática'}</div>
              <div className="faint small">{fmtDateTime(v.createdAt)} · {fmtDuration(v.duration)}</div>
            </div>
            <button className="btn sm" onClick={() => restore(v.id)}>Restaurar</button>
          </div>
        ))}
        {!list.length && <p className="faint small">Nenhuma versão ainda.</p>}
      </div>
    </Modal>
  );
}

export function EditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const project = useEditor((s) => s.project);
  const timeline = useEditor((s) => s.timeline);
  const tab = useEditor((s) => s.tab);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const saveState = useEditor((s) => s.saveState);
  const recoverable = useEditor((s) => s.recoverable);
  const brands = useApp((s) => s.brands);
  const [error, setError] = useState<{ msg: string; hint?: string } | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showSafe, setShowSafe] = useState(true);

  useEffect(() => {
    setError(null);
    useEditor
      .getState()
      .load(id!)
      .catch((e) => setError({ msg: e.message, hint: e.hint }));
    return () => {
      const st = useEditor.getState();
      if (st.saveState === 'dirty') st.save();
      st.reset();
    };
  }, [id]);

  useEffect(() => {
    if (project) {
      useApp.getState().setScope(project.brandId);
      document.title = `${project.name} — GDR Digital`;
    }
    return () => {
      document.title = 'GDR Digital';
    };
  }, [project?.id, project?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Avisa ao fechar a aba com alterações ainda não enviadas (o rascunho local também protege).
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState().saveState;
      if (s !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Atalhos de teclado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      const st = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        st.setPlaying(!st.playing);
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        st.save();
      } else if (!mod && e.key.toLowerCase() === 's') splitAtPlayhead();
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
      else if (e.key === 'ArrowLeft') seekBy(e.shiftKey ? -1 : -1 / (st.timeline?.format.fps ?? 30));
      else if (e.key === 'ArrowRight') seekBy(e.shiftKey ? 1 : 1 / (st.timeline?.format.fps ?? 30));
      else if (e.key === '+' || e.key === '=') st.setZoom(st.zoom * 1.25);
      else if (e.key === '-') st.setZoom(st.zoom / 1.25);
      else if (e.key === 'Escape') st.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (error)
    return (
      <div className="login">
        <div className="card col" style={{ gap: 12 }}>
          <b>{error.msg}</b>
          <span className="muted small">{error.hint}</span>
          <button className="btn" onClick={() => nav('/projetos')}>Voltar aos projetos</button>
        </div>
      </div>
    );
  if (!project || !timeline)
    return (
      <div className="login">
        <Spinner size={28} />
      </div>
    );

  const brand = brands.find((b) => b.id === project.brandId);
  const st = PROJECT_STATUS[project.status];

  return (
    <div className="editor">
      <header className="ed-top">
        <button className="btn ghost sm icon" onClick={() => nav('/projetos')} title="Voltar aos projetos">
          <ArrowLeft size={16} />
        </button>
        <div className="col" style={{ gap: 0, minWidth: 0 }}>
          <input className="ed-name" defaultValue={project.name} key={project.name} onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && useEditor.getState().setProjectMeta({ name: e.target.value })} aria-label="Nome do projeto" />
          <span className="faint small ellipsis">
            <span className="brand-dot" style={{ display: 'inline-block', marginRight: 6, background: brand?.profile.colors[0]?.hex }} />
            {brand?.name}
          </span>
        </div>
        <SaveIndicator />
        <span className="spacer" />
        <div className="row hide-mobile" style={{ gap: 2 }}>
          <button className="btn ghost sm icon" disabled={!past.length} onClick={() => useEditor.getState().undo()} title={past.length ? `Desfazer: ${past[past.length - 1].label} (Ctrl+Z)` : 'Nada para desfazer'}>
            <Undo2 size={16} />
          </button>
          <button className="btn ghost sm icon" disabled={!future.length} onClick={() => useEditor.getState().redo()} title={future.length ? `Refazer: ${future[0].label} (Ctrl+Shift+Z)` : 'Nada para refazer'}>
            <Redo2 size={16} />
          </button>
          <button className="btn ghost sm" onClick={() => setShowVersions(true)} title="Histórico de versões">
            <History size={16} /> Versões
          </button>
          <button className={`btn ghost sm ${showSafe ? '' : 'faint'}`} onClick={() => setShowSafe(!showSafe)} title="Mostrar áreas cobertas pela interface das redes">
            <ShieldCheck size={16} /> Área segura
          </button>
        </div>
        <select className={`select sm status-select ${st.tone}`} value={project.status} onChange={(e) => useEditor.getState().setProjectMeta({ status: e.target.value })} title="Status do projeto">
          {Object.entries(PROJECT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <button className="btn primary sm" onClick={() => setShowExport(true)} disabled={!timeline.clips.length}>
          <Download size={16} /> Exportar
        </button>
      </header>

      {saveState === 'conflict' && (
        <div className="alert danger" style={{ margin: 8 }}>
          <AlertTriangle size={18} color="var(--danger)" />
          <div style={{ flex: 1 }}>
            <div className="title">Este projeto foi alterado em outra janela.</div>
            <span className="muted small">Para não sobrescrever nada, o salvamento foi pausado. Recarregue para ver a versão mais recente — suas alterações desta janela continuam guardadas como rascunho local.</span>
          </div>
          <button className="btn sm" onClick={() => location.reload()}>Recarregar</button>
        </div>
      )}
      {recoverable && (
        <div className="alert warning" style={{ margin: 8 }}>
          <AlertTriangle size={18} color="var(--warning)" />
          <div style={{ flex: 1 }}>
            <div className="title">Encontramos alterações que não chegaram a ser salvas.</div>
            <span className="muted small">Provavelmente a janela foi fechada ou o computador desligou durante a edição.</span>
          </div>
          <button className="btn sm" onClick={() => useEditor.getState().applyRecovery(false)}>Descartar</button>
          <button className="btn primary sm" onClick={() => useEditor.getState().applyRecovery(true)}>Recuperar</button>
        </div>
      )}

      <div className="ed-body">
        <aside className="ed-panel">
          <nav className="ed-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => useEditor.getState().setTab(t.id)}>
                <t.icon size={17} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="ed-panel-body">
            {tab === 'chat' && <ChatPanel />}
            {tab === 'effects' && <EffectsPanel />}
            {tab === 'text' && <TextPanel />}
            {tab === 'music' && <MusicPanel />}
            {tab === 'media' && <MediaPanel />}
            {tab === 'captions' && <CaptionsPanel />}
            {tab === 'elements' && <ElementsPanel />}
            {tab === 'format' && <FormatPanel />}
            {tab === 'post' && <PostPanel />}
          </div>
        </aside>
        <main className="ed-center">
          <Player showSafe={showSafe} />
          <MobileTransport />
        </main>
        <Inspector />
      </div>
      <div className="ed-timeline">
        <TimelinePanel />
      </div>
      <div className="mobile-review-note">Modo revisão: assista, exporte e mude o status. Para editar a timeline, use o computador.</div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showVersions && <VersionsDialog onClose={() => setShowVersions(false)} />}
    </div>
  );
}

/** Controles de reprodução para telas pequenas (no computador ficam na timeline). */
function MobileTransport() {
  const playing = useEditor((s) => s.playing);
  const time = useEditor((s) => s.time);
  const total = useEditor((s) => (s.timeline ? timelineDuration(s.timeline) : 0));
  return (
    <div className="mobile-transport">
      <button className="btn primary icon" onClick={() => useEditor.getState().setPlaying(!playing)}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <input type="range" min={0} max={total || 1} step={0.01} value={time} onChange={(e) => (useEditor.getState().setPlaying(false), useEditor.getState().setTime(Number(e.target.value)))} />
      <span className="mono small">{fmtTime(time)} / {fmtTime(total)}</span>
    </div>
  );
}
