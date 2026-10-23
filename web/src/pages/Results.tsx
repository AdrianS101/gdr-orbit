// Resultados: métricas reais do Instagram/Facebook por período, ranking de conteúdos e tráfego pago.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ExternalLink, Download, BarChart3, FileText, TrendingUp, TrendingDown, Megaphone, Upload } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { Empty, Field, Spinner } from '../components/ui.tsx';
import { fmtDateTime, fmtRelative } from '../lib/format.ts';
import { ProfileAnalysis, AskData, Competitors, Ideas } from './Intelligence.tsx';
import { MetricsImportModal, type ImportBatch } from './MetricsImport.tsx';

const LABEL: Record<string, string> = {
  views: 'Visualizações',
  reach: 'Alcance',
  accounts_engaged: 'Contas engajadas',
  total_interactions: 'Interações',
  likes: 'Curtidas',
  comments: 'Comentários',
  shares: 'Compartilhamentos',
  saves: 'Salvamentos',
  saved: 'Salvamentos',
  profile_views: 'Visitas ao perfil',
  follows_and_unfollows: 'Novos seguidores',
  website_clicks: 'Cliques no link',
  followers_now: 'Seguidores (hoje)',
  page_impressions_unique: 'Alcance da Página',
  page_post_engagements: 'Engajamento nos posts',
  page_views_total: 'Visitas à Página',
  page_daily_follows_unique: 'Novos seguidores',
  page_video_views: 'Visualizações de vídeo',
  reactions: 'Reações',
  post_impressions_unique: 'Alcance',
  post_clicks: 'Cliques',
  post_video_views: 'Visualizações de vídeo',
  ig_reels_avg_watch_time: 'Tempo médio assistido',
  ig_reels_video_view_total_time: 'Tempo total assistido',
};
const SORTS = ['views', 'reach', 'shares', 'saved', 'total_interactions', 'comments', 'likes'];
const fmtN = (n: number | null | undefined) => (n === null || n === undefined || !isFinite(n) ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const ms = (n?: number) => (n ? `${(n / 1000).toFixed(1).replace('.', ',')}s` : '—');
const iso = (d: Date) => d.toISOString().slice(0, 10);

interface Data {
  accounts: { id: string; network: string; name: string; avatar: string | null; totals: Record<string, number | null>; prev: Record<string, number | null>; notes: string[]; fetchedAt: string | null; error: string | null; warning?: string | null }[];
  media: { id: string; externalId: string; network: string; type: string; caption: string; permalink: string; thumb: string | null; postedAt: string; metrics: Record<string, number>; account: string; source?: string; importBatch?: string | null }[];
  imports?: ImportBatch[];
  ads: { configured: boolean; adAccount?: string; items: any[]; error: string | null; fetchedAt: string | null };
  lastSync: string | null;
}

export function ResultsPage() {
  const { scope, brands } = useApp();
  const brandId = scope !== 'all' ? scope : null;
  const today = new Date();
  const [until, setUntil] = useState(iso(today));
  const [since, setSince] = useState(iso(new Date(Date.now() - 30 * 86400_000)));
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState('views');
  const [adAccounts, setAdAccounts] = useState<any[] | null>(null);
  const [tab, setTab] = useState('painel');
  const [importing, setImporting] = useState(false);

  const load = () => {
    if (!brandId) return;
    setLoading(true);
    const u = new Date(until);
    u.setDate(u.getDate() + 1);
    api
      .get<Data>(`/api/results?brandId=${brandId}&since=${new Date(since).toISOString()}&until=${u.toISOString()}`)
      .then(setData, showError)
      .finally(() => setLoading(false));
  };
  useEffect(load, [brandId, since, until]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onJob((j) => j.type === 'metrics' && j.status === 'done' && load()), [brandId, since, until]); // eslint-disable-line react-hooks/exhaustive-deps

  const preset = (d: number) => {
    setUntil(iso(new Date()));
    setSince(iso(new Date(Date.now() - d * 86400_000)));
  };
  const sync = () => api.post('/api/results/sync', { brandId, days: Math.max(90, Math.ceil((Date.now() - Date.parse(since)) / 86400_000)) }).then(() => useApp.getState().toast({ kind: 'info', title: 'Atualizando métricas', hint: 'Acompanhe em Processamentos.' }), showError);

  const paidByMedia = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const ad of data?.ads.items ?? []) for (const k of [ad.mediaId, ad.storyId]) if (k) m.set(k, [...(m.get(k) ?? []), ad]);
    return m;
  }, [data]);
  // Só ordena por métricas que a Meta realmente entregou; posts sem a métrica vão para o fim.
  const metricOf = (m: Data['media'][number], k: string) => m.metrics[k] ?? (k === 'reach' ? m.metrics.post_impressions_unique : undefined);
  const available = useMemo(() => [...SORTS, 'reactions'].filter((k) => (data?.media ?? []).some((m) => metricOf(m, k) !== undefined)), [data]);
  useEffect(() => {
    if (available.length && !available.includes(sort)) setSort(available[0]);
  }, [available]); // eslint-disable-line react-hooks/exhaustive-deps
  const ranked = useMemo(() => [...(data?.media ?? [])].sort((a, b) => (metricOf(b, sort) ?? -1) - (metricOf(a, sort) ?? -1)), [data, sort]);
  const missingPerf = !!data?.media.length && !['views', 'reach', 'shares', 'saved', 'total_interactions'].some((k) => available.includes(k));

  const exportCsv = () => {
    const keys = Array.from(new Set(ranked.flatMap((m) => Object.keys(m.metrics))));
    const rows = [['perfil', 'rede', 'tipo', 'data', 'link', 'pago', ...keys.map((k) => LABEL[k] ?? k), 'texto'], ...ranked.map((m) => [m.account, m.network, m.type, m.postedAt.slice(0, 10), m.permalink, paidByMedia.has(m.externalId) ? 'sim' : 'não', ...keys.map((k) => String(m.metrics[k] ?? '')), (m.caption ?? '').replace(/\s+/g, ' ')])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `resultados-${since}-a-${until}.csv`;
    a.click();
  };

  if (!brandId) return <Empty icon={<BarChart3 size={36} />} title="Selecione uma marca no topo">Os resultados são mostrados por marca/cliente.</Empty>;
  const brand = brands.find((b) => b.id === brandId);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Resultados</h1>
          <p>{brand?.name} · dados oficiais do Instagram e do Facebook. A Meta atualiza as métricas com atraso de até 48 h; não são em tempo real.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={sync}><RefreshCw size={16} /> Atualizar dados</button>
          <button className="btn" disabled={!ranked.length} onClick={exportCsv}><Download size={16} /> Exportar CSV</button>
          <button className="btn" onClick={() => setImporting(true)} title="Para redes sem conexão (ex.: TikTok) ou números de outra ferramenta"><Upload size={16} /> Importar planilha</button>
        </div>
      </div>

      <div className="card row wrap" style={{ gap: 10, marginBottom: 16 }}>
        {[7, 30, 90].map((d) => <button key={d} className="btn sm" onClick={() => preset(d)}>Últimos {d} dias</button>)}
        <Field label="De"><input className="input sm" type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} /></Field>
        <Field label="Até"><input className="input sm" type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} /></Field>
        <span className="faint small">Comparado ao período anterior de mesma duração. Conteúdos sincronizados {data?.lastSync ? fmtRelative(data.lastSync) : 'ainda não'}.</span>
        {loading && <Spinner />}
      </div>

      <div className="tabs" role="tablist">
        {[['painel', 'Painel'], ['perfil', 'Análise do perfil'], ['perguntas', 'Pergunte aos dados'], ['concorrentes', 'Concorrentes e tendências'], ['pautas', 'Pautas']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'perfil' && <ProfileAnalysis brandId={brandId} since={new Date(since).toISOString()} until={new Date(Date.parse(until) + 86400_000).toISOString()} />}
      {tab === 'perguntas' && <AskData brandId={brandId} since={new Date(since).toISOString()} until={new Date(Date.parse(until) + 86400_000).toISOString()} />}
      {tab === 'concorrentes' && <Competitors brandId={brandId} />}
      {tab === 'pautas' && <Ideas brandId={brandId} />}
      {tab === 'painel' && (<>

      {data && !data.accounts.length && (
        <Empty icon={<BarChart3 size={36} />} title="Nenhum perfil conectado">
          Conecte o Instagram ou o Facebook desta marca em <Link to={`/marcas/${brandId}`} style={{ color: 'var(--accent)' }}>Marcas → Perfis sociais</Link>.
        </Empty>
      )}

      {data?.accounts.map((a) => (
        <section key={a.id} className="card col" style={{ gap: 12, marginBottom: 16 }}>
          <div className="row">
            {a.avatar && <img src={a.avatar} alt="" style={{ width: 28, height: 28, borderRadius: 99 }} />}
            <b>{a.network === 'instagram' ? `@${a.name}` : a.name}</b>
            <span className="badge">{a.network === 'instagram' ? 'Instagram' : 'Facebook'}</span>
            <span className="spacer" />
            {a.fetchedAt && <span className="faint small">Fonte: Meta Graph API · consultado {fmtDateTime(a.fetchedAt)}</span>}
          </div>
          {a.error ? (
            <div className="alert danger small">{a.error}</div>
          ) : (
            <div className="kpis">
              {Object.entries(a.totals).map(([k, v]) => {
                const p = a.prev[k];
                const delta = v !== null && p ? ((v - p) / p) * 100 : null;
                return (
                  <div key={k} className="kpi" title={v === null ? 'A Meta não fornece esta métrica para esta conta/período.' : undefined}>
                    <span className="faint small">{LABEL[k] ?? k}</span>
                    <b>{fmtN(v)}</b>
                    {delta !== null && k !== 'followers_now' && (
                      <span className="small" style={{ color: delta >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {delta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {delta.toFixed(0)}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {a.notes.map((n, i) => <span key={i} className="faint small">{n}</span>)}
          {a.warning && <div className="alert warning small">{a.warning}</div>}
        </section>
      ))}

      {data && (data.accounts.length > 0 || data.media.length > 0) && (
        <section className="card col" style={{ gap: 10, marginBottom: 16 }}>
          <div className="row wrap">
            <h2 style={{ margin: 0 }}>Conteúdos que mais performaram</h2>
            <span className="spacer" />
            <span className="small muted">Ordenar por</span>
            <select className="select sm" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value)}>
              {available.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
            </select>
          </div>
          {missingPerf && (
            <div className="alert warning small">A Meta entregou só curtidas e comentários destes posts — sem visualizações, alcance, compartilhamentos ou salvamentos. O ranking abaixo usa {LABEL[sort] ?? sort}, que não mede bem o desempenho. Reconecte o perfil (permissão de insights) e clique em "Atualizar dados".</div>
          )}
          {!ranked.length && <p className="muted small">Nenhum post no período. Clique em "Atualizar dados" para buscar os posts e as métricas na Meta.</p>}
          <div className="list">
            {ranked.slice(0, 50).map((m, i) => {
              const paid = paidByMedia.get(m.externalId);
              return (
                <div key={m.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <b className="faint" style={{ width: 22 }}>{i + 1}</b>
                  <div className="thumb" style={{ width: 64, aspectRatio: '1', flex: 'none' }}>{m.thumb && <img src={m.thumb} alt="" loading="lazy" />}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap small" style={{ gap: 6 }}>
                      <span className="badge">{m.type}</span>
                      <span className="faint">{m.account} · {fmtDateTime(m.postedAt)}</span>
                      {m.source === 'manual' && <span className="badge info" title={(() => { const b = data?.imports?.find((x) => x.id === m.importBatch); return b ? `Arquivo ${b.file}, importado em ${fmtDateTime(b.createdAt)}` : 'Importado de planilha'; })()}>Importado manualmente · {m.network}</span>}
                      {paid ? <span className="badge warning"><Megaphone size={11} /> Impulsionado · R$ {paid.reduce((n, x) => n + x.spend, 0).toFixed(2)}</span> : <span className="badge">Orgânico</span>}
                    </div>
                    <div className="ellipsis small" style={{ marginTop: 4 }}>{m.caption || '(sem legenda)'}</div>
                    <div className="row wrap small muted" style={{ gap: 12, marginTop: 4 }}>
                      {Object.entries(m.metrics).map(([k, v]) => <span key={k}><b style={{ color: k === sort ? 'var(--accent)' : 'var(--text)' }}>{k.includes('time') ? ms(v) : fmtN(v)}</b> {LABEL[k] ?? k}</span>)}
                    </div>
                  </div>
                  {m.permalink && <a className="btn ghost sm" href={m.permalink} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>}
                </div>
              );
            })}
          </div>
          <span className="faint small">As métricas do post vêm do Instagram/Facebook; as do anúncio, do Gerenciador de Anúncios. A Meta não separa orgânico e pago dentro do mesmo post — por isso os dois aparecem lado a lado.</span>
        </section>
      )}

      {data && data.accounts.length > 0 && (
        <section className="card col" style={{ gap: 10, marginBottom: 16 }}>
          <h2 className="row" style={{ margin: 0 }}><Megaphone size={16} /> Tráfego pago</h2>
          {!data.ads.configured ? (
            <div className="col" style={{ gap: 8 }}>
              <span className="muted small">Escolha a conta de anúncio desta marca para ver os resultados das campanhas.</span>
              {adAccounts === null ? (
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => api.get('/api/results/ad-accounts').then(setAdAccounts, showError)}>Listar contas de anúncio</button>
              ) : (
                <div className="row wrap">
                  {adAccounts.map((a) => <button key={a.id} className="btn sm" onClick={() => api.put('/api/results/ad-account', { brandId, adAccountId: a.id }).then(load, showError)}>{a.name} ({a.currency})</button>)}
                  {!adAccounts.length && <span className="faint small">Nenhuma conta de anúncio encontrada para o seu usuário.</span>}
                </div>
              )}
            </div>
          ) : data.ads.error ? (
            <div className="alert danger small">{data.ads.error}</div>
          ) : (
            <>
              <div className="kpis">
                {[['Investimento', data.ads.items.reduce((n, x) => n + x.spend, 0), 'R$'], ['Impressões', data.ads.items.reduce((n, x) => n + x.impressions, 0)], ['Cliques', data.ads.items.reduce((n, x) => n + x.clicks, 0)]].map(([l, v, p]) => (
                  <div key={l as string} className="kpi"><span className="faint small">{l}</span><b>{p ? `${p} ${(v as number).toFixed(2)}` : fmtN(v as number)}</b></div>
                ))}
              </div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Anúncio</th><th>Campanha</th><th>Investido</th><th>Alcance</th><th>Cliques</th><th>CTR</th><th>CPC</th><th>Resultados</th></tr></thead>
                  <tbody>
                    {data.ads.items.map((x) => (
                      <tr key={x.adId}>
                        <td>{x.name}</td>
                        <td className="faint">{x.campaign}</td>
                        <td>R$ {x.spend.toFixed(2)}</td>
                        <td>{fmtN(x.reach)}</td>
                        <td>{fmtN(x.clicks)}</td>
                        <td>{x.ctr.toFixed(2)}%</td>
                        <td>R$ {x.cpc.toFixed(2)}</td>
                        <td className="small">{Object.entries(x.actions).map(([k, v]) => `${k.replace('onsite_conversion.', '').replace(/_/g, ' ')}: ${v}`).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                    {!data.ads.items.length && <tr><td colSpan={8} className="faint">Nenhum anúncio com veiculação no período.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="row small faint">
                Fonte: Meta Marketing API · {data.ads.fetchedAt && fmtDateTime(data.ads.fetchedAt)}
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => api.put('/api/results/ad-account', { brandId, adAccountId: null }).then(load, showError)}>Trocar conta de anúncio</button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="card col" style={{ gap: 6 }}>
        <h2 className="row" style={{ margin: 0 }}><FileText size={16} /> Relatório padrão GDR</h2>
        <span className="muted small">Aguardando o modelo de relatório que você vai desenvolver. Quando o padrão estiver definido, os dados desta tela serão montados nele automaticamente para enviar ao cliente.</span>
      </section>
      </>)}
      {importing && brandId && <MetricsImportModal brandId={brandId} imports={data?.imports ?? []} onClose={() => setImporting(false)} onDone={load} />}
    </>
  );
}
