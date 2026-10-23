// Importação manual de métricas (CSV). Os dados entram identificados como manuais, com arquivo e data.
import { useState } from 'react';
import { Upload, Download, Trash2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Field, Modal } from '../components/ui.tsx';
import { fmtDateTime } from '../lib/format.ts';
import { IMPORT_COLUMNS, parseMetricsCsv } from '../../../shared/metrics-import.ts';

export interface ImportBatch { id: string; file: string; rows: number; network: string; profile: string; createdAt: string }

const NETS = [['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube'], ['linkedin', 'LinkedIn']] as const;

export function MetricsImportModal({ brandId, imports, onClose, onDone }: { brandId: string; imports: ImportBatch[]; onClose: () => void; onDone: () => void }) {
  const [network, setNetwork] = useState('tiktok');
  const [profile, setProfile] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = file ? parseMetricsCsv(file.text) : null;

  const template = () => {
    const csv = `${IMPORT_COLUMNS.join(';')}\n23/10/2026;https://www.tiktok.com/@perfil/video/123;reel;Exemplo de legenda;12500;9800;830;45;60;120\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'modelo-metricas-gdr-orbit.csv';
    a.click();
  };
  const go = () => {
    if (!file) return;
    setBusy(true);
    api
      .post('/api/results/import', { brandId, network, profile, file: file.name, csv: file.text })
      .then((r) => {
        useApp.getState().toast({ kind: 'success', title: `${r.imported} conteúdo(s) importado(s)`, hint: r.errors.length ? `${r.errors.length} linha(s) ignorada(s).` : 'Aparecem no ranking com o selo "Importado manualmente".' });
        onDone();
        onClose();
      }, showError)
      .finally(() => setBusy(false));
  };

  return (
    <Modal title="Importar métricas de uma planilha" onClose={onClose} wide footer={<><button className="btn ghost" onClick={onClose}>Fechar</button><button className="btn primary" disabled={!parsed?.rows.length || !profile.trim() || busy} onClick={go}><Upload size={16} /> Importar {parsed?.rows.length ?? 0} linha(s)</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <p className="small" style={{ margin: 0 }}>Use para redes sem conexão direta (ex.: TikTok) ou números de outra ferramenta. Os dados ficam marcados como <b>importados manualmente</b>, com o nome do arquivo e a data — nunca se misturam com os dados oficiais da API.</p>
        <div className="row wrap" style={{ gap: 10 }}>
          <Field label="Rede"><select className="select sm" value={network} onChange={(e) => setNetwork(e.target.value)}>{NETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Perfil (@)"><input className="input sm" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="gdr.resultados" /></Field>
          <Field label="Arquivo CSV">
            <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then((text) => setFile({ name: f.name, text })); }} />
          </Field>
        </div>
        <span className="faint small">Colunas aceitas: {IMPORT_COLUMNS.join(', ')} (só "data" é obrigatória; separador ; ou ,). Números como 1.234, 3,4 mil ou 2,5K são entendidos. Célula vazia fica "—", nunca zero. <button className="btn ghost sm" onClick={template}><Download size={13} /> Baixar modelo</button></span>
        {parsed && (
          <div className="card col" style={{ gap: 6, background: 'var(--surface-2)' }}>
            <b className="small">{parsed.rows.length} linha(s) válida(s) · colunas reconhecidas: {parsed.columns.join(', ') || 'nenhuma'}</b>
            {parsed.errors.slice(0, 6).map((e, i) => <span key={i} className="small" style={{ color: 'var(--warning)' }}>{e}</span>)}
            {parsed.rows.slice(0, 3).map((r, i) => <span key={i} className="faint small">{r.postedAt.slice(0, 10)} · {r.type} · {Object.entries(r.metrics).map(([k, v]) => `${k} ${v}`).join(' · ') || 'sem números'}</span>)}
          </div>
        )}
        {!!imports.length && (
          <div className="col" style={{ gap: 4 }}>
            <div className="label">Importações anteriores</div>
            {imports.map((i) => (
              <div key={i.id} className="row small">
                <span>{i.file} · {i.network} @{i.profile} · {i.rows} linha(s) · {fmtDateTime(i.createdAt)}</span>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => confirm('Remover os dados desta importação?') && api.del(`/api/results/import/${i.id}`).then(onDone, showError)}><Trash2 size={13} /> Remover</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
