import { useEffect, useState } from 'react';
import { Download, Film, Play } from 'lucide-react';
import { useEditor } from './store.ts';
import { api } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { fmtBytes, fmtRelative } from '../lib/format.ts';
import { Field, Modal } from '../components/ui.tsx';
import { JobRow } from '../components/Shell.tsx';
import { even } from '../../../shared/timeline.ts';

interface ExportItem {
  id: string;
  file: string;
  size: number;
  settings: { width: number; height: number; fps: number; quality: string };
  revision: number;
  createdAt: string;
  exists: boolean;
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const timeline = useEditor((s) => s.timeline)!;
  const revision = useEditor((s) => s.revision);
  const saveState = useEditor((s) => s.saveState);
  const jobs = useApp((s) => s.jobs);
  const [scale, setScale] = useState(1);
  const [fps, setFps] = useState(timeline.format.fps);
  const [quality, setQuality] = useState('high');
  const [encoder, setEncoder] = useState('libx264');
  const [encoders, setEncoders] = useState<string[] | null>(null);
  const [exportsList, setExports] = useState<ExportItem[]>([]);
  const [watching, setWatching] = useState<ExportItem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<ExportItem[]>(`/api/projects/${project.id}/exports`).then(setExports, showError);
  useEffect(() => {
    load();
    api.get('/api/render/options').then((o) => setEncoders(o.encoders), () => setEncoders(['libx264']));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => onJob((j) => j.type === 'render' && j.projectId === project.id && j.status === 'done' && load()), [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const W = timeline.format.width;
  const H = timeline.format.height;
  const scales = [
    { k: 0.6667, label: `${even(W * 0.6667)}×${even(H * 0.6667)} (720p, rápido)` },
    { k: 1, label: `${W}×${H} (recomendado)` },
    ...(Math.max(W, H) * 2 <= 4096 ? [{ k: 2, label: `${W * 2}×${H * 2} (4K, lento)` }] : []),
  ];

  const start = async () => {
    setBusy(true);
    try {
      await useEditor.getState().save();
      await api.post(`/api/projects/${project.id}/export`, { scale, fps, quality, encoder });
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const running = Object.values(jobs).filter((j) => j.type === 'render' && j.projectId === project.id && (j.status === 'running' || j.status === 'queued' || j.status === 'failed'));

  return (
    <Modal title="Exportar vídeo MP4" onClose={onClose} wide>
      <div className="grid cols-2">
        <Field label="Resolução">
          <select className="select" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            {scales.map((s) => (
              <option key={s.k} value={s.k}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Quadros por segundo">
          <select className="select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>{f} fps</option>
            ))}
          </select>
        </Field>
        <Field label="Qualidade" help={quality === 'standard' ? 'Mais rápida; boa para rascunhos e revisão.' : quality === 'max' ? 'Arquivo final com mais detalhes; demora mais.' : 'Equilíbrio entre qualidade e tempo.'}>
          <select className="select" value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="standard">Rascunho rápido</option>
            <option value="high">Alta (recomendada)</option>
            <option value="max">Máxima</option>
          </select>
        </Field>
        <Field
          label="Processamento"
          help={!encoders ? 'Verificando aceleração por hardware neste computador…' : encoders.length > 1 ? 'A aceleração por hardware foi testada e funciona neste computador.' : 'Nenhuma aceleração por hardware disponível; usando o processador.'}
        >
          <select className="select" value={encoder} onChange={(e) => setEncoder(e.target.value)}>
            <option value="libx264">Processador (máxima compatibilidade)</option>
            {encoders?.includes('h264_qsv') && <option value="h264_qsv">Placa de vídeo Intel (mais rápido)</option>}
            {encoders?.includes('h264_nvenc') && <option value="h264_nvenc">Placa de vídeo NVIDIA (mais rápido)</option>}
          </select>
        </Field>
      </div>
      <div className="row">
        <span className="faint small" style={{ flex: 1 }}>
          Formato {timeline.format.preset}. {timeline.audio.normalize ? 'Volume normalizado para as redes.' : 'Volume original.'} O arquivo mantém legendas e logo exatamente como na prévia.
        </span>
        <button className="btn primary" disabled={busy || !timeline.clips.length || saveState === 'conflict'} onClick={start}>
          <Film size={16} /> Exportar
        </button>
      </div>

      {running.map((j) => (
        <div key={j.id} className="card" style={{ padding: 6, background: 'var(--surface-2)' }}>
          <JobRow j={j} />
        </div>
      ))}

      {watching && (
        <video src={`/api/exports/${watching.id}/file`} controls autoPlay style={{ width: '100%', maxHeight: 420, background: '#000', borderRadius: 10 }} />
      )}

      <div>
        <div className="label" style={{ marginBottom: 6 }}>Exportações deste projeto</div>
        {!exportsList.length && <p className="faint small">Nenhuma exportação ainda.</p>}
        <div className="list">
          {exportsList.map((e) => (
            <div key={e.id} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ellipsis small" style={{ fontWeight: 600 }}>{e.file}</div>
                <div className="faint small">
                  {e.settings.width}×{e.settings.height} · {e.settings.fps} fps · {fmtBytes(e.size)} · {fmtRelative(e.createdAt)}
                  {e.revision !== revision && ' · feito antes das últimas alterações'}
                </div>
              </div>
              {e.exists ? (
                <>
                  <button className="btn ghost sm" onClick={() => setWatching(e)}>
                    <Play size={14} /> Assistir
                  </button>
                  <a className="btn sm" href={`/api/exports/${e.id}/file?download=1`}>
                    <Download size={14} /> Baixar
                  </a>
                </>
              ) : (
                <span className="badge danger">Arquivo removido</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
