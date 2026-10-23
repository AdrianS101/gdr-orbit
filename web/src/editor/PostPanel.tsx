// Texto da publicação (post) gerado a partir do conteúdo real do vídeo.
// Diferente das legendas sincronizadas dentro do vídeo.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Copy, AlertTriangle, Info } from 'lucide-react';
import { useEditor } from './store.ts';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { fmtRelative } from '../lib/format.ts';
import { Field, Spinner } from '../components/ui.tsx';

interface Draft {
  id: string;
  network: string;
  objective: string | null;
  provider: string;
  createdAt: string;
  content: {
    summary: string;
    variations: { approach: string; hook: string; body: string; cta: string; hashtags: string[]; fullText: string }[];
    notes: string[];
    missingInfo: string[];
    transcriptUsed: string;
    model: string;
  };
}

export function PostPanel() {
  const project = useEditor((s) => s.project)!;
  const timeline = useEditor((s) => s.timeline)!;
  const saveState = useEditor((s) => s.saveState);
  const [networks, setNetworks] = useState<Record<string, string>>({});
  const [network, setNetwork] = useState('instagram');
  const [objective, setObjective] = useState('');
  const [notes, setNotes] = useState('');
  const [variations, setVariations] = useState(2);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);

  useEffect(() => {
    api.get('/api/copy/networks').then(setNetworks, () => {});
    api.get<Draft[]>(`/api/projects/${project.id}/post-drafts`).then(setDrafts, showError);
    api.get('/api/settings/ai').then((s) => setAiReady(!!s.active), () => setAiReady(false));
  }, [project.id]);

  const hasSpeech = timeline.captions.cues.length > 0;

  const generate = async () => {
    setBusy(true);
    try {
      await useEditor.getState().save();
      const d = await api.post<Draft>(`/api/projects/${project.id}/post-copy`, { network, objective, notes, variations });
      setDrafts([d, ...drafts]);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => useApp.getState().toast({ kind: 'success', title: 'Texto copiado' }),
      () => useApp.getState().toast({ kind: 'error', title: 'Não foi possível copiar', hint: 'Selecione o texto e copie manualmente.' }),
    );
  };

  const editVariation = async (d: Draft, i: number, fullText: string) => {
    const content = { ...d.content, variations: d.content.variations.map((v, k) => (k === i ? { ...v, fullText } : v)) };
    setDrafts(drafts.map((x) => (x.id === d.id ? { ...x, content } : x)));
    try {
      await api.patch(`/api/post-drafts/${d.id}`, { content });
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="alert info small">
        <Info size={16} style={{ flex: 'none' }} />
        <div>Este é o texto da publicação (legenda do post). Ele é escrito a partir da fala que ficou no vídeo editado e do perfil da marca — nada é inventado.</div>
      </div>
      {aiReady === false && (
        <div className="alert warning small">
          <AlertTriangle size={16} style={{ flex: 'none' }} color="var(--warning)" />
          <div>
            Nenhum provedor de IA está conectado. <Link to="/configuracoes" style={{ color: 'var(--accent)', fontWeight: 600 }}>Configurar IA</Link>
          </div>
        </div>
      )}
      {!hasSpeech && <div className="alert warning small">Sem legendas/transcrição no projeto, a IA não sabe o que o vídeo diz. Transcreva o vídeo na aba Legendas ou descreva o conteúdo nas observações.</div>}
      <Field label="Rede">
        <select className="select sm" value={network} onChange={(e) => setNetwork(e.target.value)}>
          {Object.entries(networks).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>
      <Field label="Objetivo da publicação" help="Ex.: gerar conversas no direct, levar para o site, fortalecer autoridade.">
        <input className="input sm" value={objective} onChange={(e) => setObjective(e.target.value)} />
      </Field>
      <Field label="Observações (opcional)" help="Contexto que não aparece na fala: oferta vigente, link, data do evento…">
        <textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="Variações">
        <select className="select sm" value={variations} onChange={(e) => setVariations(Number(e.target.value))}>
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </Field>
      <button className="btn primary" disabled={busy || aiReady === false || saveState === 'conflict'} onClick={generate}>
        {busy ? <Spinner size={14} /> : <Sparkles size={16} />} {busy ? 'Escrevendo… (até 1 minuto)' : 'Gerar texto do post'}
      </button>

      {drafts.map((d) => (
        <div key={d.id} className="card col" style={{ padding: 12, gap: 10, background: 'var(--surface-2)' }}>
          <div className="row small">
            <span className="badge accent">{networks[d.network] ?? d.network}</span>
            <span className="faint">{fmtRelative(d.createdAt)} · {d.content.model}</span>
          </div>
          {d.content.summary && <div className="small muted">Sobre o vídeo: {d.content.summary}</div>}
          {d.content.variations.map((v, i) => (
            <div key={i} className="col" style={{ gap: 6 }}>
              <div className="row">
                <b className="small">{v.approach}</b>
                <span className="spacer" />
                <button className="btn sm" onClick={() => copy(v.fullText)}>
                  <Copy size={12} /> Copiar
                </button>
              </div>
              <textarea className="textarea" rows={8} defaultValue={v.fullText} onBlur={(e) => e.target.value !== v.fullText && editVariation(d, i, e.target.value)} />
            </div>
          ))}
          {d.content.notes?.length > 0 && (
            <div className="small">
              <div className="label">Pontos de atenção</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="muted">
                {d.content.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {d.content.missingInfo?.length > 0 && (
            <div className="small">
              <div className="label">Informações que melhorariam o texto</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="faint">
                {d.content.missingInfo.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
