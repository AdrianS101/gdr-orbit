// Caixa de entrada: DMs e comentários do Instagram/Facebook por contato, com respostas sugeridas pela IA.
import { useEffect, useRef, useState } from 'react';
import { Inbox as InboxIcon, RefreshCw, Send, Sparkles, Pause, Play, Check, MessageCircle, AtSign } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Empty, Spinner } from '../components/ui.tsx';
import { fmtRelative, fmtDateTime } from '../lib/format.ts';
import type { SocialAccount } from './SocialAccounts.tsx';

interface Contact {
  id: string;
  accountId: string;
  network: string;
  username: string | null;
  name: string | null;
  tags: string[];
  status: 'open' | 'pending' | 'done';
  paused: boolean;
  unread: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  last: { text: string; kind: string; direction: string } | null;
}
interface Msg {
  id: string;
  externalId: string | null;
  direction: 'in' | 'out';
  kind: string;
  text: string;
  context: any;
  status: string;
  author: string;
  error: string | null;
  createdAt: string;
}

const STATUS = { open: 'Aberta', pending: 'Precisa de você', done: 'Resolvida' };
const KIND: Record<string, string> = { dm: 'Direct', comment: 'Comentário', comment_reply: 'Resposta no comentário', private_reply: 'Direct (resposta ao comentário)' };
const AUTHOR: Record<string, string> = { contact: '', human: 'Você', ai: 'IA', automation: 'Automação' };

export function InboxPage() {
  const { scope } = useApp();
  const brandId = scope !== 'all' ? scope : null;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<Contact | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<{ commentId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<(SocialAccount & { mode?: string })[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const load = () => api.get<Contact[]>(`/api/inbox/contacts?${new URLSearchParams({ ...(brandId ? { brandId } : {}), ...(status ? { status } : {}) })}`).then(setContacts, showError);
  const loadMsgs = (c: Contact) => api.get<Msg[]>(`/api/inbox/contacts/${c.id}/messages`).then((m) => (setMsgs(m), setTimeout(() => endRef.current?.scrollIntoView(), 50)), showError);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, status]);
  useEffect(() => {
    if (!brandId) return setAccounts([]);
    api.get<SocialAccount[]>(`/api/social/accounts?brandId=${brandId}`).then(async (list) => {
      const out = [];
      for (const a of list.filter((x) => x.network !== 'tiktok')) out.push({ ...a, mode: (await api.get(`/api/inbox/mode?accountId=${a.id}`)).mode });
      setAccounts(out);
    }, showError);
  }, [brandId]);

  const open = (c: Contact) => {
    setSel(c);
    setTarget(null);
    setText('');
    loadMsgs(c);
  };
  const lastComment = [...msgs].reverse().find((m) => m.kind === 'comment' && m.direction === 'in');
  const window24 = !!sel?.lastInboundAt && Date.now() - Date.parse(sel.lastInboundAt) < 24 * 3600_000 && msgs.some((m) => m.kind === 'dm' && m.direction === 'in');

  const send = async () => {
    if (!sel || !text.trim()) return;
    setBusy('send');
    try {
      await api.post(`/api/inbox/contacts/${sel.id}/send`, { text, commentId: target?.commentId });
      setText('');
      loadMsgs(sel);
      load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };
  const suggest = async () => {
    if (!sel) return;
    setBusy('ai');
    try {
      const s = await api.post(`/api/inbox/contacts/${sel.id}/suggest`);
      setText(s.reply);
      if (s.needsHuman) useApp.getState().toast({ kind: 'info', title: 'A IA precisa de você', hint: s.reason });
      loadMsgs(sel);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };
  const patch = (body: any) => sel && api.patch<Contact>(`/api/inbox/contacts/${sel.id}`, body).then((c) => (setSel(c), load()), showError);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Caixa de entrada</h1>
          <p>Directs e comentários do Instagram e do Facebook. Atualiza a cada minuto enquanto o GDR Orbit está aberto.</p>
        </div>
        <div className="actions">
          <button className="btn" disabled={busy === 'poll'} onClick={() => (setBusy('poll'), api.post('/api/inbox/poll').then(load, showError).finally(() => setBusy(null)))}>
            {busy === 'poll' ? <Spinner size={14} /> : <RefreshCw size={16} />} Buscar agora
          </button>
        </div>
      </div>

      {accounts.length > 0 && (
        <div className="card row wrap" style={{ gap: 12, marginBottom: 12 }}>
          {accounts.map((a) => (
            <div key={a.id} className="row small" style={{ gap: 6 }}>
              <b>{a.username ? `@${a.username}` : a.name}</b>
              <select className="select sm" style={{ width: 'auto' }} value={a.mode} onChange={(e) => api.put('/api/inbox/mode', { accountId: a.id, mode: e.target.value }).then(() => setAccounts(accounts.map((x) => (x.id === a.id ? { ...x, mode: e.target.value } : x))), showError)}>
                <option value="manual">Manual: IA só sugere</option>
                <option value="auto">Automático: IA responde o que souber</option>
              </select>
              {a.error && /mensagens/.test(a.error) && <span className="badge warning" title={a.error}>sem permissão de mensagens</span>}
            </div>
          ))}
          <span className="faint small">No automático, a IA só envia quando a resposta está na base de conhecimento; o resto vem para "Precisa de você".</span>
        </div>
      )}

      <div className="inbox">
        <aside className="inbox-list card">
          <div className="tabs" style={{ marginBottom: 6 }}>
            {[['', 'Todas'], ['pending', 'Precisa de você'], ['open', 'Abertas'], ['done', 'Resolvidas']].map(([k, l]) => (
              <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
            ))}
          </div>
          {!contacts.length && <Empty icon={<InboxIcon size={30} />} title="Nada por aqui">Quando chegarem directs ou comentários nos perfis conectados, eles aparecem aqui.</Empty>}
          {contacts.map((c) => (
            <button key={c.id} className={`inbox-item ${sel?.id === c.id ? 'on' : ''}`} onClick={() => open(c)}>
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{c.username ? `@${c.username}` : c.name ?? 'Contato'}</b>
                {c.unread > 0 && <span className="badge accent">{c.unread}</span>}
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 11 }}>{fmtRelative(c.lastMessageAt)}</span>
              </div>
              <div className="row small faint" style={{ gap: 4 }}>
                {c.last?.kind === 'comment' ? <AtSign size={11} /> : <MessageCircle size={11} />}
                <span className="ellipsis">{c.last?.text}</span>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <span className={`badge ${c.status === 'pending' ? 'warning' : c.status === 'done' ? 'success' : ''}`}>{STATUS[c.status]}</span>
                {c.paused && <span className="badge">automação pausada</span>}
                {c.tags.map((t) => <span key={t} className="badge">#{t}</span>)}
              </div>
            </button>
          ))}
        </aside>

        <section className="inbox-thread card">
          {!sel ? (
            <Empty icon={<MessageCircle size={30} />} title="Escolha uma conversa" />
          ) : (
            <>
              <div className="row wrap" style={{ gap: 6, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                <b>{sel.username ? `@${sel.username}` : sel.name}</b>
                <span className="badge">{sel.network === 'instagram' ? 'Instagram' : 'Facebook'}</span>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => patch({ paused: !sel.paused })} title="Pausar automações e IA para esta pessoa">
                  {sel.paused ? <Play size={14} /> : <Pause size={14} />} {sel.paused ? 'Retomar automação' : 'Pausar automação'}
                </button>
                <button className="btn ghost sm" onClick={() => patch({ status: sel.status === 'done' ? 'open' : 'done' })}>
                  <Check size={14} /> {sel.status === 'done' ? 'Reabrir' : 'Marcar como resolvida'}
                </button>
                <input className="input sm" style={{ width: 160 }} placeholder="etiquetas, vírgula" defaultValue={sel.tags.join(', ')} key={sel.id} onBlur={(e) => patch({ tags: e.target.value.split(',') })} />
              </div>
              <div className="thread">
                {msgs.map((m) => (
                  <div key={m.id} className={`bubble ${m.direction} ${m.status}`}>
                    <div className="faint" style={{ fontSize: 10, marginBottom: 2 }}>
                      {KIND[m.kind] ?? m.kind}
                      {AUTHOR[m.author] ? ` · ${AUTHOR[m.author]}` : ''} · {fmtDateTime(m.createdAt)}
                      {m.status === 'suggested' && ' · sugestão (não enviada)'}
                      {m.status === 'failed' && ' · não enviada'}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                    {m.error && <div className="small" style={{ color: 'var(--danger)' }}>{m.error}</div>}
                    {m.context?.reason && m.status === 'suggested' && <div className="small faint">IA: {m.context.reason}</div>}
                    {m.kind === 'comment' && m.direction === 'in' && (
                      <button className="btn ghost sm" onClick={() => setTarget({ commentId: m.externalId ?? '' })}>Responder neste comentário</button>
                    )}
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div className="col" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div className="row small" style={{ gap: 6 }}>
                  <span className="faint">Responder:</span>
                  <button className={`btn sm ${!target ? 'primary' : ''}`} disabled={!window24} onClick={() => setTarget(null)} title={window24 ? '' : 'A Meta só permite DM até 24 h depois da última mensagem da pessoa.'}>
                    no Direct
                  </button>
                  {lastComment && (
                    <button className={`btn sm ${target ? 'primary' : ''}`} onClick={() => setTarget({ commentId: lastComment.externalId ?? '' })}>
                      no comentário
                    </button>
                  )}
                  {!window24 && <span className="faint">Direct indisponível: fora da janela de 24 h.</span>}
                </div>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva ou peça uma sugestão à IA" />
                  <div className="col" style={{ gap: 4 }}>
                    <button className="btn sm" disabled={busy === 'ai'} onClick={suggest} title="Sugestão baseada na base de conhecimento da marca">
                      {busy === 'ai' ? <Spinner size={14} /> : <Sparkles size={14} />} Sugerir
                    </button>
                    <button className="btn primary sm" disabled={!text.trim() || busy === 'send' || (!target && !window24)} onClick={send}>
                      <Send size={14} /> Enviar
                    </button>
                  </div>
                </div>
                <span className="faint" style={{ fontSize: 11 }}>A IA usa só o que está no perfil e na base de conhecimento da marca — não inventa preços nem condições.</span>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
