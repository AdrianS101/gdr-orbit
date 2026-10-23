import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Clapperboard, Plus, Trash2, Check, Film } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { fmtDuration, fmtRelative, PROJECT_STATUS } from '../lib/format.ts';
import { Empty, Field, Modal } from '../components/ui.tsx';
import { UploadButton } from './Library.tsx';
import { FORMAT_PRESETS } from '../../../shared/timeline.ts';
import type { Asset, FormatPreset, ProjectSummary } from '../../../shared/types.ts';

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { brands, scope } = useApp();
  const nav = useNavigate();
  const [brandId, setBrandId] = useState(scope !== 'all' ? scope : brands[0]?.id ?? '');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<FormatPreset>('9:16');
  const [custom, setCustom] = useState({ width: 1080, height: 1920 });
  const [videos, setVideos] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => brandId && api.get<Asset[]>(`/api/assets?brandId=${brandId}&kind=video`).then(setVideos, showError);
  useEffect(() => {
    load();
    setSelected([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);
  useEffect(() => onJob((j) => j.type === 'ingest' && j.status === 'done' && load()), [brandId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.post('/api/projects', { brandId, name, preset, custom, assetIds: selected });
      useApp.getState().setScope(brandId);
      nav(`/editor/${p.id}`);
    } catch (e) {
      showError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Novo projeto de edição"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint small" style={{ marginRight: 'auto' }}>{selected.length ? `${selected.length} vídeo(s) entram na timeline na ordem escolhida` : 'Você pode adicionar vídeos depois, no editor.'}</span>
          <button className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!brandId || busy} onClick={create}>Criar e abrir editor</button>
        </>
      }
    >
      {!brands.length ? (
        <p className="muted">Cadastre uma marca antes de criar um projeto.</p>
      ) : (
        <>
          <div className="grid cols-2">
            <Field label="Nome do projeto">
              <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Reels — case cliente do Paraná" />
            </Field>
            <Field label="Marca">
              <select className="select" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Formato" help="Dá para mudar o formato depois, no editor. O vídeo é reenquadrado automaticamente.">
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
              {(Object.keys(FORMAT_PRESETS) as (keyof typeof FORMAT_PRESETS)[]).map((k) => {
                const f = FORMAT_PRESETS[k];
                const on = preset === k;
                return (
                  <button key={k} className="card hover col" style={{ padding: 10, gap: 6, alignItems: 'center', borderColor: on ? 'var(--accent)' : undefined }} onClick={() => setPreset(k)}>
                    <div style={{ height: 44, display: 'grid', placeItems: 'center' }}>
                      <div style={{ width: (f.width / Math.max(f.width, f.height)) * 40, height: (f.height / Math.max(f.width, f.height)) * 40, border: `2px solid ${on ? 'var(--accent)' : 'var(--text-3)'}`, borderRadius: 4 }} />
                    </div>
                    <b className="small">{f.label}</b>
                    <span className="faint" style={{ fontSize: 11, textAlign: 'center' }}>{f.hint}</span>
                  </button>
                );
              })}
              <button className="card hover col" style={{ padding: 10, gap: 6, alignItems: 'center', borderColor: preset === 'custom' ? 'var(--accent)' : undefined }} onClick={() => setPreset('custom')}>
                <div style={{ height: 44, display: 'grid', placeItems: 'center' }} className="faint">W×H</div>
                <b className="small">Personalizado</b>
              </button>
            </div>
          </Field>
          {preset === 'custom' && (
            <div className="row">
              <input className="input sm" type="number" style={{ width: 110 }} value={custom.width} onChange={(e) => setCustom({ ...custom, width: Number(e.target.value) })} />
              <span>×</span>
              <input className="input sm" type="number" style={{ width: 110 }} value={custom.height} onChange={(e) => setCustom({ ...custom, height: Number(e.target.value) })} />
              <span className="faint small">pixels (64 a 4096)</span>
            </div>
          )}
          <Field label="Vídeos">
            <div className="row">
              <span className="faint small">Clique para escolher (a ordem dos cliques define a ordem na timeline).</span>
              <span className="spacer" />
              {brandId && <UploadButton brandId={brandId} accept="video/*" label="Enviar vídeo" onUploaded={() => load()} />}
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
              {videos.map((v) => {
                const idx = selected.indexOf(v.id);
                const ready = v.status === 'ready';
                return (
                  <button
                    key={v.id}
                    className="card hover col"
                    disabled={!ready}
                    style={{ padding: 8, gap: 6, borderColor: idx >= 0 ? 'var(--accent)' : undefined, opacity: ready ? 1 : 0.6 }}
                    onClick={() => setSelected(idx >= 0 ? selected.filter((s) => s !== v.id) : [...selected, v.id])}
                  >
                    <div className="thumb">
                      {ready ? <img src={media.poster(v.id)} alt="" /> : <Film size={18} />}
                      {v.meta.duration && <span className="dur">{fmtDuration(v.meta.duration)}</span>}
                      {idx >= 0 && (
                        <span className="badge accent" style={{ position: 'absolute', left: 6, top: 6, background: 'var(--accent)', color: 'var(--on-accent)' }}>
                          <Check size={11} /> {idx + 1}
                        </span>
                      )}
                    </div>
                    <span className="small ellipsis">{ready ? v.name : 'Preparando…'}</span>
                  </button>
                );
              })}
              {!videos.length && <span className="faint small">Nenhum vídeo nesta marca ainda.</span>}
            </div>
          </Field>
        </>
      )}
    </Modal>
  );
}

export function ProjectsPage() {
  const { scope, brands } = useApp();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('novo') === '1');
  const [status, setStatus] = useState('');

  const load = () => api.get<ProjectSummary[]>(`/api/projects${scope !== 'all' ? `?brandId=${scope}` : ''}`).then(setProjects, showError);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Excluir o projeto "${p.name}"? Os arquivos da biblioteca e os vídeos exportados não são apagados.`)) return;
    try {
      await api.del(`/api/projects/${p.id}`);
      load();
    } catch (e) {
      showError(e);
    }
  };

  const list = (projects ?? []).filter((p) => !status || p.status === status);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projetos e editor</h1>
          <p>Edite vídeos com timeline, legendas animadas e identidade da marca.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Novo projeto
          </button>
        </div>
      </div>
      <div className="tabs">
        {[['', 'Todos'], ...Object.entries(PROJECT_STATUS).map(([k, v]) => [k, v.label])].map(([k, l]) => (
          <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
            {l}
          </button>
        ))}
      </div>
      {projects && !list.length ? (
        <Empty icon={<Clapperboard size={36} />} title="Nenhum projeto aqui" action={<button className="btn primary" onClick={() => setCreating(true)}>Criar projeto</button>}>
          Um projeto reúne vídeos, cortes, legendas, exportações e o texto do post.
        </Empty>
      ) : (
        <div className="grid auto">
          {list.map((p) => {
            const st = PROJECT_STATUS[p.status];
            return (
              <div key={p.id} className="card col" style={{ padding: 10, gap: 8 }}>
                <Link to={`/editor/${p.id}`} className="thumb">
                  {p.thumbAssetId ? <img src={media.poster(p.thumbAssetId)} alt="" loading="lazy" /> : <Clapperboard size={22} />}
                  <span className="dur">{fmtDuration(p.duration)}</span>
                </Link>
                <Link to={`/editor/${p.id}`} className="ellipsis" style={{ fontWeight: 600 }}>{p.name}</Link>
                <div className="row small faint">
                  <span className="ellipsis">{brands.find((b) => b.id === p.brandId)?.name}</span>
                  <span>· {p.format.preset}</span>
                  <span className="spacer" />
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                </div>
                <div className="row">
                  <span className="faint small">Editado {fmtRelative(p.updatedAt)}</span>
                  <span className="spacer" />
                  <button className="btn ghost sm icon" title="Excluir projeto" onClick={() => remove(p)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {creating && (
        <NewProjectModal
          onClose={() => {
            setCreating(false);
            if (params.get('novo')) setParams({});
          }}
        />
      )}
    </>
  );
}
