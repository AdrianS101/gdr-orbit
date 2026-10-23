import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Upload, Film, Image as ImageIcon, Music, Type, Trash2, Search, HardDrive, FileText, Tag, Scissors } from 'lucide-react';
import { api, media, uploadFile } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { fmtBytes, fmtDuration, fmtRelative } from '../lib/format.ts';
import { Empty, Field, Modal, Progress } from '../components/ui.tsx';
import type { Asset } from '../../../shared/types.ts';
import { DriveFolders } from './DriveSettings.tsx';
import { useNavigate } from 'react-router-dom';
import { ReelsModal } from './ReelsModal.tsx';

const KINDS = [
  { id: '', label: 'Tudo' },
  { id: 'video', label: 'Vídeos' },
  { id: 'image', label: 'Imagens e logos' },
  { id: 'audio', label: 'Áudios' },
  { id: 'font', label: 'Fontes' },
];

/** Envia vários arquivos em sequência, mostrando o progresso de cada um. */
export function useUploader(brandId: string | null, onUploaded?: (a: Asset, duplicate: boolean) => void) {
  const [queue, setQueue] = useState<{ name: string; progress: number }[]>([]);
  const run = async (files: File[]) => {
    if (!brandId) {
      useApp.getState().toast({ kind: 'error', title: 'Selecione uma marca antes de enviar arquivos.', hint: 'Use o seletor de marca no topo da tela. Os arquivos de cada marca ficam separados.' });
      return;
    }
    setQueue(files.map((f) => ({ name: f.name, progress: 0 })));
    for (let i = 0; i < files.length; i++) {
      try {
        const { promise } = uploadFile(`/api/brands/${brandId}/assets`, files[i], (p) => setQueue((q) => q.map((x, k) => (k === i ? { ...x, progress: p } : x))));
        const r = await promise;
        if (r.duplicate) useApp.getState().toast({ kind: 'info', title: `"${files[i].name}" já estava na biblioteca`, hint: 'O arquivo existente foi reaproveitado — nada foi duplicado.' });
        onUploaded?.(r.asset, r.duplicate);
      } catch (e) {
        showError(e);
      }
    }
    setQueue([]);
  };
  return { queue, run };
}

export function UploadButton({ brandId, accept, label = 'Enviar arquivos', onUploaded, primary }: { brandId: string; accept?: string; label?: string; onUploaded?: (a: Asset) => void; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { queue, run } = useUploader(brandId, onUploaded);
  const busy = queue.length > 0;
  const done = queue.filter((q) => q.progress >= 1).length;
  return (
    <>
      <input ref={input} type="file" multiple hidden accept={accept} onChange={(e) => (run(Array.from(e.target.files ?? [])), (e.target.value = ''))} />
      <button className={`btn ${primary ? 'primary' : ''}`} disabled={busy} onClick={() => input.current?.click()}>
        <Upload size={16} />
        {busy ? `Enviando ${Math.min(done + 1, queue.length)}/${queue.length}…` : label}
      </button>
    </>
  );
}

function kindIcon(k: string) {
  return k === 'video' ? <Film size={20} /> : k === 'image' ? <ImageIcon size={20} /> : k === 'audio' ? <Music size={20} /> : <Type size={20} />;
}

export function LibraryPage() {
  const { scope, brands, jobs } = useApp();
  const brandId = scope !== 'all' ? scope : null;
  const [assets, setAssets] = useState<Asset[]>([]);
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [over, setOver] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [reels, setReels] = useState<Asset | null>(null);
  const nav = useNavigate();

  const load = () => {
    const q = new URLSearchParams();
    if (brandId) q.set('brandId', brandId);
    if (kind) q.set('kind', kind);
    if (search) q.set('search', search);
    return api.get<Asset[]>(`/api/assets?${q}`).then(setAssets, showError);
  };
  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, kind, search]);
  useEffect(() => onJob((j) => j.type === 'ingest' && (j.status === 'done' || j.status === 'failed') && load()), [brandId, kind, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const { queue, run } = useUploader(brandId, () => load());

  const remove = async (a: Asset) => {
    if (!confirm(`Excluir "${a.name}" da biblioteca? O arquivo será apagado do armazenamento do GDR Orbit (o arquivo de origem no seu computador não é afetado).`)) return;
    try {
      await api.del(`/api/assets/${a.id}`);
      load();
    } catch (e) {
      showError(e);
    }
  };

  const jobFor = (a: Asset) => Object.values(jobs).find((j) => j.assetId === a.id && j.type === 'ingest' && (j.status === 'running' || j.status === 'queued' || j.status === 'failed'));

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        run(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="page-head">
        <div>
          <h1>Biblioteca</h1>
          <p>{brandId ? `Arquivos de ${brands.find((b) => b.id === brandId)?.name}` : 'Arquivos de todas as marcas'}. Os originais são preservados sem alteração.</p>
        </div>
        {brandId && (
          <div className="actions">
            <button className="btn" onClick={() => setPathOpen(true)} title="Importar um arquivo que já está neste computador, sem reenviar">
              <HardDrive size={16} /> Importar por caminho
            </button>
            <UploadButton brandId={brandId} primary onUploaded={() => load()} />
          </div>
        )}
      </div>

      {!brandId && (
        <div className="alert info" style={{ marginBottom: 16 }}>
          <div>
            <div className="title">Para enviar arquivos, selecione uma marca no topo da tela.</div>
            <div className="muted small">Assim cada material fica associado ao cliente certo.</div>
          </div>
        </div>
      )}

      {brandId && <DriveFolders brandId={brandId} onImported={load} />}

      {queue.length > 0 && (
        <div className="card col" style={{ marginBottom: 16 }}>
          {queue.map((q, i) => (
            <div key={i} className="col" style={{ gap: 4 }}>
              <div className="row small">
                <span className="ellipsis" style={{ flex: 1 }}>{q.name}</span>
                <span className="faint">{Math.round(q.progress * 100)}%</span>
              </div>
              <Progress value={q.progress} />
            </div>
          ))}
        </div>
      )}

      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div className="tabs" style={{ marginBottom: 0, borderBottom: 0 }}>
          {KINDS.map((k) => (
            <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="row" style={{ position: 'relative', minWidth: 240 }}>
          <Search size={14} style={{ position: 'absolute', left: 10 }} className="faint" />
          <input className="input" style={{ paddingLeft: 30 }} placeholder="Buscar por nome ou etiqueta" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {over && brandId && <div className="dropzone over" style={{ marginBottom: 16 }}>Solte os arquivos para enviar à biblioteca</div>}

      {!assets.length ? (
        <Empty icon={<FolderOpen size={36} />} title={search || kind ? 'Nada encontrado' : 'Biblioteca vazia'}>
          {brandId ? 'Arraste vídeos, imagens, áudios ou fontes para cá, ou use o botão "Enviar arquivos".' : 'Selecione uma marca para começar.'}
        </Empty>
      ) : (
        <div className="grid auto">
          {assets.map((a) => {
            const j = jobFor(a);
            return (
              <div key={a.id} className="card col" style={{ padding: 10, gap: 8 }}>
                <div className={`thumb ${a.kind === 'image' ? 'contain' : ''}`} style={a.kind === 'image' ? { background: 'var(--bg)' } : undefined}>
                  {a.kind === 'video' && a.status === 'ready' ? <img src={media.poster(a.id)} alt="" loading="lazy" /> : a.kind === 'image' ? <img src={media.original(a.id)} alt="" loading="lazy" /> : kindIcon(a.kind)}
                  {a.meta.duration ? <span className="dur">{fmtDuration(a.meta.duration)}</span> : null}
                </div>
                <div className="ellipsis" style={{ fontWeight: 600 }} title={a.name}>{a.name}</div>
                <div className="row wrap small faint" style={{ gap: 6 }}>
                  <span>{fmtBytes(a.size)}</span>
                  {a.meta.width && <span>· {a.meta.width}×{a.meta.height}</span>}
                  {a.kind === 'font' && <span>· {(a.meta as any).family}</span>}
                  <span>· {fmtRelative(a.createdAt)}</span>
                </div>
                <div className="row wrap" style={{ gap: 4 }}>
                  {a.status === 'processing' && <span className="badge accent">Preparando</span>}
                  {a.status === 'failed' && <span className="badge danger">Falhou</span>}
                  {a.transcriptStatus === 'ready' && (
                    <span className="badge info">
                      <FileText size={11} /> Transcrito
                    </span>
                  )}
                  {a.source === 'local' && <span className="badge">Importado do computador</span>}
                  {a.source === 'drive' && <span className="badge info">Google Drive</span>}
                  {a.kind !== 'font' && a.usage && (a.usage.projects || a.usage.posts ? <span className="badge success">Usado: {a.usage.projects} projeto(s), {a.usage.posts} post(s)</span> : <span className="badge">Ainda não usado</span>)}
                  {a.tags.map((t) => (
                    <span key={t} className="badge">#{t}</span>
                  ))}
                </div>
                {j && (j.status === 'running' || j.status === 'queued') && (
                  <div className="col" style={{ gap: 4 }}>
                    <Progress value={j.progress} indeterminate={j.status === 'queued'} />
                    <span className="faint small">{j.message}</span>
                  </div>
                )}
                {j?.status === 'failed' && <div className="small" style={{ color: 'var(--danger)' }}>{j.error}</div>}
                <div className="row" style={{ marginTop: 'auto' }}>
                  <button className="btn ghost sm" onClick={() => setEditing(a)}>
                    <Tag size={14} /> Etiquetas
                  </button>
                  <span className="spacer" />
                  {a.kind === 'video' && a.status === 'ready' && (
                    <button className="btn ghost sm" title="Criar projeto de edição com este vídeo" onClick={() => api.post('/api/projects', { brandId: a.brandId, name: a.name.replace(/\.[^.]+$/, ''), preset: '9:16', assetIds: [a.id] }).then((p) => nav('/editor/' + p.id), showError)}>
                      Editar
                    </button>
                  )}
                  {a.kind === 'video' && a.status === 'ready' && a.meta.hasAudio && (
                    <button className="btn ghost sm" title="Gerar vários Reels a partir deste vídeo (entrevista, podcast, live)" onClick={() => setReels(a)}>
                      <Scissors size={14} /> Reels
                    </button>
                  )}
                  <button className="btn ghost sm icon" title="Excluir" onClick={() => remove(a)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pathOpen && brandId && <ImportPathModal brandId={brandId} onClose={() => setPathOpen(false)} onDone={load} />}
      {reels && <ReelsModal asset={reels} onClose={() => { setReels(null); load(); }} />}
      {editing && <TagsModal asset={editing} onClose={() => setEditing(null)} onDone={load} />}
    </div>
  );
}

function ImportPathModal({ brandId, onClose, onDone }: { brandId: string; onClose: () => void; onDone: () => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/brands/${brandId}/assets/import-path`, { filePath: path });
      useApp.getState().toast({ kind: r.duplicate ? 'info' : 'success', title: r.duplicate ? 'Esse arquivo já estava na biblioteca' : 'Arquivo importado', hint: r.duplicate ? 'Nada foi duplicado.' : 'A preparação começou.' });
      onDone();
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Importar arquivo deste computador" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!path.trim() || busy} onClick={go}>{busy ? 'Copiando…' : 'Importar'}</button></>}>
      <Field label="Caminho completo do arquivo" help='No Explorador de Arquivos, clique com o botão direito no arquivo e escolha "Copiar como caminho". Útil para vídeos grandes: o arquivo é copiado direto, sem passar pelo navegador.'>
        <input className="input mono" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\voce\Videos\gravacao.mp4" />
      </Field>
    </Modal>
  );
}

function TagsModal({ asset, onClose, onDone }: { asset: Asset; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(asset.name);
  const [tags, setTags] = useState(asset.tags.join(', '));
  const save = async () => {
    try {
      await api.patch(`/api/assets/${asset.id}`, { name, tags: tags.split(',') });
      onDone();
      onClose();
    } catch (e) {
      showError(e);
    }
  };
  return (
    <Modal title="Organizar arquivo" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar</button></>}>
      <Field label="Nome">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Etiquetas" help="Separe por vírgula. Ex.: entrevista, bastidores, cliente-x">
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </Modal>
  );
}
