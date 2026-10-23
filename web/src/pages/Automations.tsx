// Automações de comentário → DM (palavra-chave), com editor visual, teste simulado e histórico.
import { useEffect, useState } from 'react';
import { Workflow, Plus, Trash2, Play, Pause, FlaskConical, History, ArrowDown, MessageSquare, AtSign, Send } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Empty, Field, Modal } from '../components/ui.tsx';
import { fmtDateTime } from '../lib/format.ts';
import { EMPTY_AUTOMATION, type AutomationConfig } from '../../../shared/automation.ts';
import type { SocialAccount } from './SocialAccounts.tsx';

interface Automation {
  id: string;
  accountId: string;
  name: string;
  active: boolean;
  config: AutomationConfig;
  stats: { triggered: number; sent: number; failed: number };
}

function Editor({ brandId, initial, onClose, onSaved }: { brandId: string; initial: Automation | null; onClose: () => void; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountId, setAccountId] = useState(initial?.accountId ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [cfg, setCfg] = useState<AutomationConfig>(initial?.config ?? EMPTY_AUTOMATION);
  const [media, setMedia] = useState<{ id: string; caption: string; thumb: string | null; postedAt: string }[]>([]);
  const [test, setTest] = useState({ comment: '', reply: '' });
  const [testOut, setTestOut] = useState<string[] | null>(null);
  const set = (p: Partial<AutomationConfig>) => setCfg({ ...cfg, ...p });

  useEffect(() => {
    api.get<SocialAccount[]>(`/api/social/accounts?brandId=${brandId}`).then((l) => {
      const ok = l.filter((a) => a.network !== 'tiktok');
      setAccounts(ok);
      if (!accountId && ok[0]) setAccountId(ok[0].id);
    }, showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);
  useEffect(() => {
    if (accountId) api.get(`/api/automations/media?accountId=${accountId}`).then(setMedia, () => setMedia([]));
  }, [accountId]);

  const save = async () => {
    try {
      if (initial) await api.put(`/api/automations/${initial.id}`, { name, config: cfg });
      else await api.post('/api/automations', { accountId, name, config: cfg });
      onSaved();
      onClose();
    } catch (e) {
      showError(e);
    }
  };
  const runTest = () => api.post('/api/automations/test', { config: cfg, comment: test.comment, reply: test.reply }).then((r) => setTestOut(r.steps), showError);

  return (
    <Modal title={initial ? 'Editar automação' : 'Nova automação'} wide onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar</button></>}>
      <div className="grid cols-2">
        <Field label="Nome">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder='Ex.: Guia gratuito — palavra "GUIA"' />
        </Field>
        <Field label="Perfil">
          <select className="select" value={accountId} disabled={!!initial} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.username ? `@${a.username}` : a.name} ({a.network})</option>)}
          </select>
        </Field>
      </div>

      <div className="flow">
        <div className="flow-node">
          <div className="flow-title"><AtSign size={14} /> Quando alguém comentar</div>
          <Field label="Palavras-chave (separe por vírgula)" help="Maiúsculas, acentos e emojis são ignorados.">
            <input className="input" value={cfg.keywords.join(', ')} onChange={(e) => set({ keywords: e.target.value.split(',').map((x) => x.trim()) })} placeholder="GUIA, quero" />
          </Field>
          <div className="row small" style={{ gap: 10 }}>
            <label className="row"><input type="radio" checked={cfg.match === 'contains'} onChange={() => set({ match: 'contains' })} /> contém a palavra</label>
            <label className="row"><input type="radio" checked={cfg.match === 'exact'} onChange={() => set({ match: 'exact' })} /> comentário é exatamente a palavra</label>
          </div>
          <Field label="Em quais publicações">
            <div className="row small" style={{ gap: 10 }}>
              <label className="row"><input type="radio" checked={cfg.mediaIds === 'all'} onChange={() => set({ mediaIds: 'all' })} /> todas</label>
              <label className="row"><input type="radio" checked={cfg.mediaIds !== 'all'} onChange={() => set({ mediaIds: [] })} /> escolher</label>
            </div>
            {cfg.mediaIds !== 'all' && (
              <div className="media-pick">
                {media.map((m) => {
                  const on = (cfg.mediaIds as string[]).includes(m.id);
                  return (
                    <button key={m.id} className={`media-pick-item ${on ? 'on' : ''}`} onClick={() => set({ mediaIds: on ? (cfg.mediaIds as string[]).filter((x) => x !== m.id) : [...(cfg.mediaIds as string[]), m.id] })}>
                      {m.thumb ? <img src={m.thumb} alt="" /> : <div style={{ aspectRatio: '1', background: '#000' }} />}
                      <span className="ellipsis small">{m.caption || fmtDateTime(m.postedAt)}</span>
                    </button>
                  );
                })}
                {!media.length && <span className="faint small">Sincronize as publicações em Resultados → "Atualizar dados" para escolher.</span>}
              </div>
            )}
          </Field>
        </div>
        <ArrowDown size={16} className="faint" />
        <div className="flow-node">
          <div className="flow-title"><MessageSquare size={14} /> Responder no comentário (opcional)</div>
          <Field label="Uma opção por linha — o sistema alterna para não repetir a mesma frase">
            <textarea className="textarea" rows={2} value={cfg.commentReplies.join('\n')} onChange={(e) => set({ commentReplies: e.target.value.split('\n') })} />
          </Field>
        </div>
        <ArrowDown size={16} className="faint" />
        <div className="flow-node">
          <div className="flow-title"><Send size={14} /> Enviar no Direct</div>
          <Field label="Mensagem" help="Use {nome} para o primeiro nome da pessoa.">
            <textarea className="textarea" rows={3} value={cfg.dm} onChange={(e) => set({ dm: e.target.value })} />
          </Field>
          <div className="grid cols-2">
            <Field label="Texto do link (opcional)"><input className="input sm" value={cfg.link?.label ?? ''} onChange={(e) => set({ link: { label: e.target.value, url: cfg.link?.url ?? '' } })} placeholder="Baixe aqui" /></Field>
            <Field label="Link"><input className="input sm" value={cfg.link?.url ?? ''} onChange={(e) => set({ link: { label: cfg.link?.label ?? '', url: e.target.value } })} placeholder="https://" /></Field>
          </div>
        </div>
        <ArrowDown size={16} className="faint" />
        <div className="flow-node">
          <div className="flow-title">Pergunta de continuidade (opcional)</div>
          <Field label="Pergunta enviada junto com a DM">
            <input className="input" value={cfg.followUp?.question ?? ''} onChange={(e) => set({ followUp: { question: e.target.value, options: cfg.followUp?.options ?? [] } })} placeholder="Quer que eu te mande também o checklist? Responda SIM" />
          </Field>
          {(cfg.followUp?.options ?? []).map((o, i) => (
            <div key={i} className="row">
              <input className="input sm" style={{ width: 120 }} value={o.keyword} placeholder="SIM" onChange={(e) => set({ followUp: { ...cfg.followUp!, options: cfg.followUp!.options.map((x, k) => (k === i ? { ...x, keyword: e.target.value } : x)) } })} />
              <input className="input sm" value={o.reply} placeholder="Resposta enviada" onChange={(e) => set({ followUp: { ...cfg.followUp!, options: cfg.followUp!.options.map((x, k) => (k === i ? { ...x, reply: e.target.value } : x)) } })} />
              <button className="btn ghost sm icon" onClick={() => set({ followUp: { ...cfg.followUp!, options: cfg.followUp!.options.filter((_, k) => k !== i) } })}><Trash2 size={14} /></button>
            </div>
          ))}
          {cfg.followUp?.question && (
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ followUp: { question: cfg.followUp!.question, options: [...(cfg.followUp!.options ?? []), { keyword: '', reply: '' }] } })}>
              <Plus size={12} /> Opção de resposta
            </button>
          )}
        </div>
      </div>

      <div className="card col" style={{ gap: 8, background: 'var(--surface-2)' }}>
        <b className="row"><FlaskConical size={14} /> Testar (simulação — nada é enviado)</b>
        <div className="row">
          <input className="input sm" placeholder="Comentário de teste, ex.: quero o GUIA!" value={test.comment} onChange={(e) => setTest({ ...test, comment: e.target.value })} />
          <input className="input sm" placeholder="Resposta no direct (opcional)" value={test.reply} onChange={(e) => setTest({ ...test, reply: e.target.value })} />
          <button className="btn sm" disabled={!test.comment} onClick={runTest}>Testar</button>
        </div>
        {testOut && <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{testOut.map((s, i) => <li key={i} style={{ whiteSpace: 'pre-wrap' }}>{s}</li>)}</ol>}
      </div>
      <span className="faint small">Regras da Meta: a resposta privada só pode ser enviada até 7 dias depois do comentário, e cada pessoa recebe a DM uma vez por automação. Nem todas as funções valem para todas as redes: no TikTok esta automação não está disponível.</span>
    </Modal>
  );
}

export function AutomationsPage() {
  const { scope } = useApp();
  const brandId = scope !== 'all' ? scope : null;
  const [list, setList] = useState<Automation[]>([]);
  const [edit, setEdit] = useState<Automation | null | undefined>(undefined);
  const [runs, setRuns] = useState<{ a: Automation; items: any[] } | null>(null);
  const load = () => api.get<Automation[]>(`/api/automations${brandId ? `?brandId=${brandId}` : ''}`).then(setList, showError);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  if (!brandId) return <Empty icon={<Workflow size={36} />} title="Selecione uma marca no topo">As automações são configuradas por perfil de cada marca.</Empty>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automações</h1>
          <p>Comentou a palavra-chave → recebe a DM com o material. Verificação a cada minuto enquanto o GDR Orbit está aberto.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setEdit(null)}><Plus size={16} /> Nova automação</button>
        </div>
      </div>
      {!list.length && <Empty icon={<Workflow size={36} />} title="Nenhuma automação" action={<button className="btn primary" onClick={() => setEdit(null)}>Criar a primeira</button>}>Ex.: quem comentar "GUIA" recebe o link do guia no direct.</Empty>}
      <div className="grid auto">
        {list.map((a) => (
          <div key={a.id} className="card col" style={{ gap: 8 }}>
            <div className="row">
              <b className="ellipsis" style={{ flex: 1 }}>{a.name}</b>
              <span className={`badge ${a.active ? 'success' : ''}`}>{a.active ? 'Ativa' : 'Pausada'}</span>
            </div>
            <div className="small muted">Palavras: {a.config.keywords.join(', ')}</div>
            <div className="small faint">{a.config.mediaIds === 'all' ? 'Todas as publicações' : `${a.config.mediaIds.length} publicação(ões)`}</div>
            <div className="row small" style={{ gap: 10 }}>
              <span>Disparos: <b>{a.stats.triggered}</b></span>
              <span>DMs enviadas: <b>{a.stats.sent}</b></span>
              {a.stats.failed > 0 && <span style={{ color: 'var(--danger)' }}>Falhas: <b>{a.stats.failed}</b></span>}
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm" onClick={() => api.post(`/api/automations/${a.id}/active`, { active: !a.active }).then(load, showError)}>
                {a.active ? <Pause size={14} /> : <Play size={14} />} {a.active ? 'Pausar' : 'Ativar'}
              </button>
              <button className="btn ghost sm" onClick={() => setEdit(a)}>Editar</button>
              <button className="btn ghost sm" onClick={() => api.get(`/api/automations/${a.id}/runs`).then((items) => setRuns({ a, items }), showError)}><History size={14} /> Histórico</button>
              <span className="spacer" />
              <button className="btn ghost sm icon" onClick={() => confirm('Excluir esta automação?') && api.del(`/api/automations/${a.id}`).then(load, showError)}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {edit !== undefined && <Editor brandId={brandId} initial={edit} onClose={() => setEdit(undefined)} onSaved={load} />}
      {runs && (
        <Modal title={`Histórico — ${runs.a.name}`} onClose={() => setRuns(null)} wide>
          {!runs.items.length && <p className="muted">Nenhum disparo ainda.</p>}
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Quando</th><th>Pessoa</th><th>Etapa</th><th>Situação</th><th>Detalhe</th></tr></thead>
              <tbody>
                {runs.items.map((r, i) => (
                  <tr key={i}>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td>{r.contact ?? '—'}</td>
                    <td>{{ trigger: 'Comentário', comment_reply: 'Resposta pública', dm: 'Direct', followup: 'Continuidade' }[r.step as string] ?? r.step}</td>
                    <td><span className={`badge ${r.status === 'done' ? 'success' : r.status === 'failed' ? 'danger' : ''}`}>{{ done: 'Feito', failed: 'Falhou', skipped: 'Ignorado', running: 'Em andamento' }[r.status as string] ?? r.status}</span></td>
                    <td className="small faint" style={{ whiteSpace: 'normal' }}>{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
