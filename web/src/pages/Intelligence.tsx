// Abas de inteligência em Resultados: análise do perfil, perguntas aos dados, concorrentes/tendências e pautas.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, Plus, Trash2, FileText, Clapperboard, ExternalLink, Search, Lightbulb } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Empty, Field, Spinner } from '../components/ui.tsx';
import { fmtDateTime } from '../lib/format.ts';

const KIND: Record<string, string> = { verificado: 'var(--success)', observação: 'var(--info)', hipótese: 'var(--warning)' };
const toast = (title: string, hint?: string) => useApp.getState().toast({ kind: 'info', title, hint });

function addIdea(brandId: string, title: string, details: string, source: string) {
  return api.post('/api/ideas', { brandId, title, details, source }).then(() => toast('Pauta criada', 'Veja na aba Pautas.'), showError);
}

function Recommendations({ data, brandId, source }: { data: any; brandId: string; source: string }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <p>{data.summary}</p>
      {data.bio && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <b>Bio</b>
          <p className="small">{data.bio.assessment}</p>
          <p className="small"><b>Sugestão:</b> {data.bio.suggestion}</p>
        </div>
      )}
      {data.recommendations.map((r: any, i: number) => (
        <div key={i} className="card col" style={{ gap: 6, background: 'var(--surface-2)' }}>
          <div className="row">
            <b>{r.title}</b>
            <span className="badge" style={{ color: KIND[r.kind] }}>{r.kind}</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => addIdea(brandId, r.title, `Evidência: ${r.evidence}\nMudança: ${r.change}\nResultado esperado: ${r.expected}\nMétrica: ${r.metric}`, source)}><Lightbulb size={14} /> Virar pauta</button>
          </div>
          <span className="small"><b>Evidência:</b> {r.evidence}</span>
          <span className="small"><b>Mudança:</b> {r.change}</span>
          <span className="small"><b>Resultado a testar:</b> {r.expected}</span>
          <span className="small"><b>Métrica:</b> {r.metric}</span>
        </div>
      ))}
      <p className="faint small">Limitações: {data.dataNote}</p>
    </div>
  );
}

const fmtN = (v: number | null | undefined, d = 0) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d }));

export function ProfileAnalysis({ brandId, since, until }: { brandId: string; since: string; until: string }) {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    api.post('/api/intel/profile', { brandId, since, until }).then(setRes, showError).finally(() => setBusy(false));
  };
  const s = res?.stats;
  return (
    <section className="card col" style={{ gap: 12 }}>
      <div className="row wrap">
        <div>
          <b>Análise do perfil do Instagram</b>
          <p className="faint small">Números calculados dos posts do período (Meta). A IA interpreta e indica evidência, mudança, resultado a testar e métrica.</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? <Spinner /> : <Sparkles size={16} />} Analisar período</button>
      </div>
      {res?.note && <p className="faint">{res.note}</p>}
      {s && (
        <>
          {!s.enough && <p className="small" style={{ color: 'var(--warning)' }}>Poucos posts no período ({s.posts}). As conclusões são fracas — amplie o período para pelo menos 10 posts.</p>}
          <div className="kpis">
            <div className="kpi"><span className="faint small">Posts</span><b>{s.posts}</b></div>
            <div className="kpi"><span className="faint small">Por semana</span><b>{fmtN(s.perWeek, 1)}</b></div>
            <div className="kpi"><span className="faint small">Mediana de visualizações</span><b>{fmtN(s.medianViews)}</b></div>
            {res.profile?.followers_count != null && <div className="kpi"><span className="faint small">Seguidores</span><b>{fmtN(res.profile.followers_count)}</b></div>}
          </div>
          <div className="small">
            <b>Por formato (medianas):</b>{' '}
            {Object.entries(s.byType).map(([t, v]: any) => `${t}: ${v.n} posts · ${fmtN(v.views)} views`).join(' | ')}
          </div>
          <div className="small">
            <b>Por dia:</b> {s.byWeekday.filter((d: any) => d.n).map((d: any) => `${d.day} (${d.n}) ${fmtN(d.views)}`).join(' · ')}
          </div>
          <div className="small">
            <b>Por horário:</b> {s.byTime.filter((d: any) => d.n).map((d: any) => `${d.slot} (${d.n}) ${fmtN(d.views)}`).join(' · ')}
          </div>
        </>
      )}
      {res?.analysis && <Recommendations data={res.analysis} brandId={brandId} source="análise do perfil" />}
      {res?.at && <span className="faint small">Gerado {fmtDateTime(res.at)} · {res.model}</span>}
    </section>
  );
}

export function AskData({ brandId, since, until }: { brandId: string; since: string; until: string }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ q: string; r: any }[]>([]);
  const ask = (question = q) => {
    if (!question.trim()) return;
    setBusy(true);
    api
      .post('/api/intel/ask', { brandId, since, until, question, history: history.map((h) => ({ q: h.q, a: h.r.answer })) })
      .then((r) => {
        setHistory((h) => [...h, { q: question, r }]);
        setQ('');
      }, showError)
      .finally(() => setBusy(false));
  };
  const examples = ['Quais vídeos tiveram mais visualizações e por quê?', 'Qual formato funciona melhor?', 'Qual o melhor dia para postar?', 'O que mudou em relação ao período anterior?'];
  return (
    <section className="card col" style={{ gap: 12 }}>
      <div>
        <b>Pergunte aos dados</b>
        <p className="faint small">Responde só com os números sincronizados do período e cita os posts usados. Quando a Meta não fornece um dado, a resposta diz isso.</p>
      </div>
      {!history.length && (
        <div className="row wrap" style={{ gap: 6 }}>
          {examples.map((e) => <button key={e} className="btn sm" onClick={() => ask(e)} disabled={busy}>{e}</button>)}
        </div>
      )}
      {history.map((h, i) => (
        <div key={i} className="col" style={{ gap: 6 }}>
          <div className="small" style={{ alignSelf: 'flex-end', background: 'var(--surface-3)', padding: '6px 10px', borderRadius: 10 }}>{h.q}</div>
          <div className="card col" style={{ gap: 8, background: 'var(--surface-2)' }}>
            <p style={{ whiteSpace: 'pre-wrap' }}>{h.r.answer}</p>
            {!!h.r.references?.length && (
              <div className="col small" style={{ gap: 4 }}>
                <b>Posts usados</b>
                {h.r.references.map((x: any, j: number) => (
                  <span key={j}>
                    {x.post ? <a href={x.post.permalink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{x.post.postedAt.slice(0, 10)} · {x.post.type} <ExternalLink size={11} /></a> : x.postId} — {x.why}
                  </span>
                ))}
              </div>
            )}
            {h.r.limitations && <span className="faint small">Limitações: {h.r.limitations}</span>}
            {!!h.r.actions?.length && (
              <div className="row wrap" style={{ gap: 6 }}>
                {h.r.actions.map((a: any, j: number) => <button key={j} className="btn sm" onClick={() => addIdea(brandId, a.title, a.details, `pergunta: ${h.q}`)}><Lightbulb size={14} /> {a.kind}: {a.title}</button>)}
              </div>
            )}
            <span className="faint small">{h.r.posts} posts analisados · {h.r.model}</span>
          </div>
        </div>
      ))}
      <div className="row">
        <input className="input" style={{ flex: 1 }} placeholder="Ex.: quais posts mais trouxeram compartilhamentos?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => ask()}>{busy ? <Spinner /> : <Send size={16} />}</button>
      </div>
    </section>
  );
}

export function Competitors({ brandId }: { brandId: string }) {
  const [list, setList] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [res, setRes] = useState<any>(null);
  const [trends, setTrends] = useState<any>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api.get<string[]>(`/api/intel/competitors?brandId=${brandId}`).then(setList, showError);
    setRes(null);
    setTrends(null);
  }, [brandId]);
  const save = (l: string[]) => api.put('/api/intel/competitors', { brandId, usernames: l }).then(() => setList(l.map((u) => u.replace(/^@/, '').toLowerCase())), showError);
  const run = () => {
    setBusy('bench');
    api.post('/api/intel/benchmark', { brandId }).then(setRes, showError).finally(() => setBusy(''));
  };
  const runTrends = () => {
    setBusy('trends');
    api.post('/api/intel/trends', { brandId }).then(setTrends, showError).finally(() => setBusy(''));
  };
  const row = (c: any, own = false) => (
    <tr key={c.username}>
      <td><a href={`https://instagram.com/${c.username}`} target="_blank" rel="noreferrer" style={{ color: own ? 'var(--accent)' : undefined }}>@{c.username}</a></td>
      <td>{fmtN(c.followers)}</td>
      <td>{fmtN(c.perWeek, 1)}</td>
      <td>{c.medianEngagement == null ? '—' : `${fmtN(c.medianEngagement, 2)}%`}</td>
      <td className="small">{Object.entries(c.byType).map(([t, v]: any) => `${t} ${v.n} (${v.engagement == null ? '—' : fmtN(v.engagement, 2) + '%'})`).join(' · ')}</td>
    </tr>
  );
  return (
    <>
      <section className="card col" style={{ gap: 12, marginBottom: 16 }}>
        <div>
          <b>Concorrentes e referências</b>
          <p className="faint small">Dados públicos de perfis profissionais do Instagram pela API oficial (últimos 25 posts): seguidores, frequência e engajamento ((curtidas+comentários) ÷ seguidores). Visualizações de terceiros não são fornecidas pela Meta.</p>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {list.map((u) => (
            <span key={u} className="badge row" style={{ gap: 4 }}>@{u} <button className="icon-btn" aria-label={`Remover ${u}`} onClick={() => save(list.filter((x) => x !== u))}><Trash2 size={12} /></button></span>
          ))}
          <input className="input sm" placeholder="@perfil" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) { save([...list, input]); setInput(''); } }} />
          <button className="btn sm" disabled={!input.trim()} onClick={() => { save([...list, input]); setInput(''); }}><Plus size={14} /> Adicionar</button>
          <span className="spacer" />
          <button className="btn primary" disabled={!list.length || !!busy} onClick={run}>{busy === 'bench' ? <Spinner /> : <Search size={16} />} Comparar</button>
        </div>
        {res && (
          <>
            {!!res.errors.length && <p className="small" style={{ color: 'var(--warning)' }}>{res.errors.join(' · ')}</p>}
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Perfil</th><th>Seguidores</th><th>Posts/sem.</th><th>Engaj. mediano</th><th>Por formato</th></tr></thead>
                <tbody>{res.own && row(res.own, true)}{res.competitors.map((c: any) => row(c))}</tbody>
              </table>
            </div>
            {res.competitors.map((c: any) => (
              <details key={c.username} className="small">
                <summary>Posts com mais engajamento de @{c.username}</summary>
                {c.top.map((m: any) => <div key={m.permalink}><a href={m.permalink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{m.postedAt.slice(0, 10)} · {m.type} · {fmtN(m.engagement, 2)}%</a> — {m.caption.slice(0, 120)}</div>)}
              </details>
            ))}
            {res.synthesis && <Recommendations data={res.synthesis} brandId={brandId} source="concorrentes" />}
            <span className="faint small">Consultado {fmtDateTime(res.at)} · Meta Graph API (business_discovery)</span>
          </>
        )}
      </section>
      <section className="card col" style={{ gap: 10 }}>
        <div className="row wrap">
          <div>
            <b>Tendências na web</b>
            <p className="faint small">Pesquisa com fontes e datas pela Busca do Google no Gemini. Nada é mostrado sem fonte.</p>
          </div>
          <span className="spacer" />
          <button className="btn" disabled={!!busy} onClick={runTrends}>{busy === 'trends' ? <Spinner /> : <Search size={16} />} Pesquisar</button>
        </div>
        {trends && !trends.available && <p className="small" style={{ color: 'var(--warning)' }}>{trends.reason}</p>}
        {trends?.available && (
          <>
            <p style={{ whiteSpace: 'pre-wrap' }}>{trends.text}</p>
            <div className="col small">
              <b>Fontes</b>
              {trends.sources.map((s: any, i: number) => <a key={i} href={s.uri} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{s.title}</a>)}
            </div>
          </>
        )}
      </section>
    </>
  );
}

const STATUS: Record<string, string> = { idea: 'Ideia', script: 'Roteiro', production: 'Em produção', done: 'Concluída' };

export function Ideas({ brandId }: { brandId: string }) {
  const nav = useNavigate();
  const [items, setItems] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api.get<any[]>(`/api/ideas?brandId=${brandId}`).then(setItems, showError);
  useEffect(() => void load(), [brandId]); // eslint-disable-line react-hooks/exhaustive-deps
  const upd = (id: string, b: any) => api.patch(`/api/ideas/${id}`, b).then(load, showError);
  return (
    <section className="card col" style={{ gap: 12 }}>
      <div>
        <b>Pautas</b>
        <p className="faint small">Ideias vindas da análise, das perguntas ou escritas por você. Gere o roteiro com IA e abra um projeto de edição.</p>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <input className="input" placeholder="Título da pauta" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input" rows={2} placeholder="Detalhes (opcional)" value={details} onChange={(e) => setDetails(e.target.value)} />
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!title.trim()} onClick={() => api.post('/api/ideas', { brandId, title, details }).then(() => { setTitle(''); setDetails(''); load(); }, showError)}><Plus size={14} /> Adicionar pauta</button>
      </div>
      {!items.length && <Empty icon={<Lightbulb size={30} />} title="Nenhuma pauta ainda">Use "Virar pauta" nas recomendações ou crie uma acima.</Empty>}
      {items.map((it) => (
        <div key={it.id} className="card col" style={{ gap: 6, background: 'var(--surface-2)' }}>
          <div className="row wrap">
            <b>{it.title}</b>
            <span className="badge">{STATUS[it.status]}</span>
            <span className="faint small">{it.source}</span>
            <span className="spacer" />
            <select className="input sm" value={it.status} onChange={(e) => upd(it.id, { status: e.target.value })} aria-label="Status">
              {Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button className="btn sm" disabled={!!busy} onClick={() => { setBusy(it.id); api.post(`/api/ideas/${it.id}/script`).then(load, showError).finally(() => setBusy('')); }}>{busy === it.id ? <Spinner /> : <FileText size={14} />} {it.script ? 'Refazer roteiro' : 'Gerar roteiro'}</button>
            <button className="btn sm" onClick={() => api.post(`/api/ideas/${it.id}/project`).then((r) => nav(`/editor/${r.projectId}`), showError)}><Clapperboard size={14} /> {it.projectId ? 'Abrir projeto' : 'Criar projeto'}</button>
            <button className="icon-btn" aria-label="Excluir pauta" onClick={() => api.del(`/api/ideas/${it.id}`).then(load, showError)}><Trash2 size={14} /></button>
          </div>
          {it.details && <span className="small" style={{ whiteSpace: 'pre-wrap' }}>{it.details}</span>}
          {it.script && (
            <Field label="Roteiro (editável)">
              <textarea className="input" rows={8} defaultValue={it.script} onBlur={(e) => e.target.value !== it.script && upd(it.id, { script: e.target.value })} />
            </Field>
          )}
        </div>
      ))}
    </section>
  );
}
