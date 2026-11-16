// Relatório de resultados no modelo padrão GDR (GDR-Modelo-Relatorio): os números vêm só dos dados reais
// (Meta Graph API, Marketing API e planilhas importadas); o Claude lê esses dados e escreve os textos,
// escolhe quais métricas destacar e os próximos passos. Nenhum número é escrito pela IA.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { db, getSetting, now } from '../db.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { enqueue, type JobContext } from '../jobs/queue.ts';
import { accountTotals, adsReport } from './insights.ts';
import { MetaError } from './meta.ts';
import { findClaudeCli, generateJson, readSecrets, type ProviderId } from '../ai/providers.ts';
import { uid } from '../../../shared/timeline.ts';

const LABEL: Record<string, string> = {
  views: 'Visualizações', reach: 'Alcance', accounts_engaged: 'Contas engajadas', total_interactions: 'Interações', likes: 'Curtidas',
  comments: 'Comentários', shares: 'Compartilhamentos', saves: 'Salvamentos', saved: 'Salvamentos', profile_views: 'Visitas ao perfil',
  follows_and_unfollows: 'Novos seguidores', website_clicks: 'Cliques no link', followers_now: 'Seguidores',
  page_impressions_unique: 'Alcance da Página', page_post_engagements: 'Engajamento nos posts', page_views_total: 'Visitas à Página',
  page_daily_follows_unique: 'Novos seguidores da Página', page_video_views: 'Visualizações de vídeo',
};

interface Metric { id: string; label: string; cur: number | null; prev: number | null; prev2: number | null; unit?: 'R$' | '%'; onlyNow?: boolean }
interface MediaRow { id: string; date: string; postedAt: string; format: string; caption: string; account: string; network: string; permalink: string | null; views: number | null; reach: number | null; interactions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; source: string }

const DAY = 86400_000;
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
const fmtDateY = (ms: number) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtNum = (n: number | null, unit?: string) => {
  if (n === null || !isFinite(n)) return '—';
  if (unit === 'R$') return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === '%') return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
};
const pct = (a: number | null, b: number | null) => (a === null || b === null || !b ? null : ((a - b) / b) * 100);
const fmtPct = (p: number | null) => (p === null ? '' : `${p >= 0 ? '+' : ''}${p.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Texto da IA: escapado; **negrito** vira <b>. */
const rich = (s: unknown) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// ---------- coleta (só dados reais) ----------

async function collect(brandId: string, since: number, until: number) {
  const len = until - since;
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId) as any;
  if (!brand) throw badRequest('Marca não encontrada.');
  const accounts = db.prepare("SELECT * FROM social_accounts WHERE brand_id = ? AND network IN ('instagram','facebook') AND token IS NOT NULL ORDER BY network DESC").all(brandId) as any[];
  const metrics: Metric[] = [];
  const problems: string[] = [];
  const multi = accounts.length > 1;
  const sec = (ms: number) => Math.floor(ms / 1000);
  for (const a of accounts) {
    const net = a.network === 'instagram' ? 'Instagram' : 'Facebook';
    try {
      const cur = await accountTotals(a, sec(since), sec(until));
      const prev = await accountTotals(a, sec(since - len), sec(since)).catch(() => ({ totals: {} as Record<string, number | null> }));
      const prev2 = await accountTotals(a, sec(since - 2 * len), sec(since - len)).catch(() => ({ totals: {} as Record<string, number | null> }));
      for (const [k, v] of Object.entries(cur.totals as Record<string, number | null>)) {
        if (v === null || v === undefined) continue;
        metrics.push({ id: `${a.network}.${k}`, label: `${LABEL[k] ?? k}${multi ? ` (${net})` : ''}`, cur: v, prev: k === 'followers_now' ? null : prev.totals[k] ?? null, prev2: k === 'followers_now' ? null : prev2.totals[k] ?? null, onlyNow: k === 'followers_now' });
      }
    } catch (e) {
      problems.push(`${net} @${a.username ?? a.name}: ${e instanceof MetaError ? e.message : (e as Error).message}`);
    }
  }

  // Entregas do período (posts sincronizados da Meta + planilhas importadas).
  const ids = (db.prepare('SELECT id FROM social_accounts WHERE brand_id = ?').all(brandId) as any[]).map((r) => r.id);
  const rows = ids.length
    ? (db.prepare(`SELECT m.*, a.username, a.name AS account_name FROM media_items m JOIN social_accounts a ON a.id = m.account_id WHERE m.account_id IN (${ids.map(() => '?').join(',')}) AND m.posted_at >= ? AND m.posted_at < ? ORDER BY m.posted_at`).all(...ids, new Date(since).toISOString(), new Date(until).toISOString()) as any[])
    : [];
  const FMT: Record<string, string> = { reel: 'Reel', video: 'Vídeo', carousel: 'Carrossel', image: 'Post', post: 'Post' };
  const media: MediaRow[] = rows.map((m) => {
    const x = JSON.parse(m.metrics || '{}');
    const n = (k: string) => (typeof x[k] === 'number' ? x[k] : null);
    return {
      id: m.id, postedAt: m.posted_at, date: fmtDate(Date.parse(m.posted_at)), format: FMT[m.type] ?? m.type, caption: String(m.caption ?? '').replace(/\s+/g, ' ').trim(),
      account: m.username ?? m.account_name, network: m.network, permalink: m.permalink, source: m.source ?? 'meta',
      views: n('views') ?? n('post_video_views'), reach: n('reach') ?? n('post_impressions_unique'), interactions: n('total_interactions'),
      likes: n('likes') ?? n('reactions'), comments: n('comments'), shares: n('shares'), saves: n('saved') ?? n('saves'),
    };
  });
  // Entregas dos períodos anteriores (para o comparativo de quantidade de posts).
  const countIn = (a: number, b: number) => (ids.length ? (db.prepare(`SELECT COUNT(*) AS n FROM media_items WHERE account_id IN (${ids.map(() => '?').join(',')}) AND posted_at >= ? AND posted_at < ?`).get(...ids, new Date(a).toISOString(), new Date(b).toISOString()) as any).n : 0);
  metrics.push({ id: 'posts.count', label: 'Publicações no período', cur: media.length, prev: countIn(since - len, since), prev2: countIn(since - 2 * len, since - len) });
  const sumViews = (list: MediaRow[]) => (list.some((m) => m.views !== null) ? list.reduce((s, m) => s + (m.views ?? 0), 0) : null);
  if (sumViews(media) !== null) metrics.push({ id: 'posts.views', label: 'Visualizações dos posts do período', cur: sumViews(media), prev: null, prev2: null });

  // Tráfego pago, se a marca tiver conta de anúncio escolhida.
  const adAccount = getSetting<string | null>(`brand.adAccount.${brandId}`, null);
  let spend: number | null = null;
  if (adAccount) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const sum = (items: any[], k: string) => items.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    try {
      const [c, p, p2] = await Promise.all([adsReport(adAccount, day(since), day(until - 1)), adsReport(adAccount, day(since - len), day(since - 1)).catch(() => ({ items: [] })), adsReport(adAccount, day(since - 2 * len), day(since - len - 1)).catch(() => ({ items: [] }))]);
      spend = sum(c.items, 'spend');
      const ctr = (items: any[]) => (sum(items, 'impressions') ? (sum(items, 'clicks') / sum(items, 'impressions')) * 100 : null);
      const cpc = (items: any[]) => (sum(items, 'clicks') ? sum(items, 'spend') / sum(items, 'clicks') : null);
      metrics.push(
        { id: 'ads.spend', label: 'Investimento em anúncios', cur: spend, prev: sum(p.items, 'spend'), prev2: sum(p2.items, 'spend'), unit: 'R$' },
        { id: 'ads.reach', label: 'Alcance dos anúncios', cur: sum(c.items, 'reach'), prev: sum(p.items, 'reach'), prev2: sum(p2.items, 'reach') },
        { id: 'ads.clicks', label: 'Cliques nos anúncios', cur: sum(c.items, 'clicks'), prev: sum(p.items, 'clicks'), prev2: sum(p2.items, 'clicks') },
        { id: 'ads.ctr', label: 'CTR dos anúncios', cur: ctr(c.items), prev: ctr(p.items), prev2: ctr(p2.items), unit: '%' },
        { id: 'ads.cpc', label: 'Custo por clique', cur: cpc(c.items), prev: cpc(p.items), prev2: cpc(p2.items), unit: 'R$' },
      );
    } catch (e) {
      problems.push(`Anúncios: ${e instanceof MetaError ? e.message : (e as Error).message}`);
    }
  }
  const handle = accounts.find((a) => a.network === 'instagram')?.username ?? accounts[0]?.username ?? accounts[0]?.name ?? null;
  return { brand, handle, metrics, media, spend, problems, len };
}

// ---------- IA (Claude) ----------

interface AiReport {
  headline: string; highlight: string; summary: string;
  heroMetrics: string[]; heroNote: string;
  evolutionTitle: string; evolutionContext: string; evolutionMetrics: string[]; changes: { title: string; text: string }[];
  periodsText: string; periodMetrics: string[]; periodsNote: string;
  highlightsTitle: string; highlights: { mediaId: string; title: string }[]; highlightsNote: string;
  tableNote: string; honest: string; nextSteps: { title: string; text: string }[];
}

const str = { type: 'string' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'highlight', 'summary', 'heroMetrics', 'heroNote', 'evolutionTitle', 'evolutionContext', 'evolutionMetrics', 'changes', 'periodsText', 'periodMetrics', 'periodsNote', 'highlightsTitle', 'highlights', 'highlightsNote', 'tableNote', 'honest', 'nextSteps'],
  properties: {
    headline: str, highlight: str, summary: str,
    heroMetrics: { type: 'array', items: str }, heroNote: str,
    evolutionTitle: str, evolutionContext: str, evolutionMetrics: { type: 'array', items: str },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'text'], properties: { title: str, text: str } } },
    periodsText: str, periodMetrics: { type: 'array', items: str }, periodsNote: str,
    highlightsTitle: str, highlights: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['mediaId', 'title'], properties: { mediaId: str, title: str } } }, highlightsNote: str,
    tableNote: str, honest: str,
    nextSteps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'text'], properties: { title: str, text: str } } },
  },
};

const SYSTEM = `Você é analista de resultados da agência GDR Gestão de Resultados e escreve o relatório mensal para o cliente, em português do Brasil.
Regras obrigatórias:
- Use SOMENTE os números e posts fornecidos. Nunca invente número, porcentagem, meta ou fato. Se um dado não existe, diga que não foi medido.
- Os números do relatório são preenchidos pelo sistema: nos textos você pode citar valores, mas copie exatamente os fornecidos.
- Escreva de forma direta, para dono de empresa (sem jargão). Frases curtas.
- Seja honesto: cite sempre o que não funcionou, o que caiu e o que ficou sem resultado.
- "headline": resultado principal em uma frase (máx. 90 caracteres); "highlight": trecho EXATO da headline a destacar (2 a 4 palavras).
- "summary": 2 a 3 linhas; marque com **negrito** o número mais importante e o principal ponto de atenção.
- "heroMetrics": 7 ids de métricas (da lista), o 1º é a métrica principal do período. Prefira métricas com valor do período anterior.
- "evolutionMetrics": 4 ids com valor atual e anterior. "changes": 4 itens curtos do que mudou entre os períodos.
- "periodMetrics": 3 ids que tenham valores nos 3 períodos (A, B, C). Explique em "periodsText" o que cada período representa e em "periodsNote" por que subiu ou caiu.
- "highlights": até 3 posts (use o id exato da lista "posts"), com título curto (máx. 60 caracteres) baseado na legenda. "highlightsNote": padrão que se repetiu.
- "nextSteps": exatamente 3 próximos passos práticos e testáveis.
- Use apenas ids que existem nas listas.`;

function pickProvider(): ProviderId {
  if (readSecrets().ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (findClaudeCli()) return 'claude-cli';
  throw new AppError(400, 'O Claude não está conectado neste computador.', 'Abra o app do Claude neste PC (o Claude Code vem junto) ou cole a chave da API da Anthropic em Configurações → IA.');
}

// ---------- montagem do HTML no modelo GDR ----------

let logoUri: string | null = null;
function logo() {
  if (logoUri) return logoUri;
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'gdr-logo-relatorio.png');
  logoUri = fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString('base64')}` : '';
  return logoUri;
}

const CSS = `:root{--bg:#010000;--surface:#111112;--surface2:#1C1C1E;--line:#2a2a2d;--fg:#FFFFFF;--silver:#E4E4E5;--muted:#8C898A;--accent:#F47A00;--a1:#E55D03;--a2:#FB9C13;--accent-soft:rgba(244,122,0,.14);--grad:linear-gradient(90deg,#E55D03,#FB9C13);--display:"Sora",system-ui,sans-serif;--body:"Inter",system-ui,-apple-system,sans-serif;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--body);font-size:15px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{max-width:1080px;margin:0 auto;padding:40px 20px 64px;display:flex;flex-direction:column;gap:64px}
h1,h2,h3{font-family:var(--display);margin:0;line-height:1.08;text-wrap:balance}p{margin:0}
.eyebrow{font-family:var(--display);font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px}.topbar img{height:64px;display:block}
.btns{display:flex;gap:8px}.btn{font:600 12px var(--body);color:var(--silver);background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer}.btn.on{background:var(--grad);color:#000;border-color:transparent}
.cover{display:flex;flex-direction:column;gap:18px;border-top:2px solid transparent;border-image:var(--grad) 1;padding-top:28px}
.cover h1{font-size:clamp(34px,6vw,64px);font-weight:800;letter-spacing:-.02em}
.tarja{background:var(--grad);color:#000;padding:0 .18em;border-radius:4px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.lede{max-width:64ch;color:var(--muted);font-size:17px}.lede b{color:var(--fg);font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:8px}.chip{font-size:12px;padding:5px 11px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}.chip.on{border-color:var(--accent);color:var(--a2);background:var(--accent-soft)}
.hero-nums{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.n{background:var(--surface);padding:22px 20px;display:flex;flex-direction:column;gap:6px;min-width:0}
.n .v{font-family:var(--display);font-weight:800;font-size:clamp(30px,4.2vw,46px);line-height:1;font-variant-numeric:tabular-nums}
.n .l{font-weight:600}.n .s{font-size:13px;color:var(--muted)}
.n.big{grid-column:span 2;background:linear-gradient(135deg,rgba(244,122,0,.18),transparent 70%),var(--surface)}
.n.big .v{font-size:clamp(46px,7vw,80px);background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.note{font-size:13px;color:var(--muted)}
section{display:flex;flex-direction:column;gap:22px}.sec-head{display:flex;flex-direction:column;gap:8px;max-width:72ch}.sec-head h2{font-size:clamp(26px,3.6vw,38px);font-weight:700}.sec-head p{color:var(--muted)}
.ba{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.4fr);gap:24px;align-items:start}.shot{display:flex;flex-direction:column;gap:12px;min-width:0}
.tag{display:inline-flex;align-self:flex-start;font-family:var(--display);font-weight:700;font-size:15px;letter-spacing:.04em;text-transform:uppercase;padding:5px 12px;border-radius:6px;border:1px solid var(--line);color:var(--muted)}
.shot.now .tag{background:var(--grad);border-color:transparent;color:#000}
.frame{border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--surface);position:relative;min-height:220px}
.shot.now .frame{border:2px solid var(--accent);box-shadow:0 0 0 6px var(--accent-soft),0 30px 60px -30px rgba(244,122,0,.5)}
.frame img{display:block;width:100%}.shot.before .frame img{filter:saturate(.7) brightness(.92)}
.slot{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--muted);font-size:13px;cursor:pointer;border:1.5px dashed var(--line);border-radius:12px;margin:10px;text-align:center;padding:12px}
.slot b{color:var(--a2);font-family:var(--display)}.slot:hover{border-color:var(--accent)}
.cmp{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.cmp td{padding:9px 0;border-bottom:1px solid var(--line);vertical-align:top}
.cmp td:first-child{color:var(--muted);width:42%;padding-right:12px}.cmp td.up{color:var(--a2);font-weight:600}.cmp td.down{color:#ef6b6b;font-weight:600}
.changes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ch{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;padding:16px;background:var(--surface);display:flex;flex-direction:column;gap:4px}.ch b{font-weight:600}.ch span{color:var(--muted);font-size:14px}
.pair{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.card{border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--surface);display:flex;flex-direction:column;gap:14px;min-width:0}.card h3{font-size:18px;font-weight:700}
.mult{font-family:var(--display);font-weight:800;font-size:40px;line-height:1;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.bars{display:flex;flex-direction:column;gap:12px}.bar{display:grid;grid-template-columns:64px minmax(0,1fr) 64px;gap:12px;align-items:center}
.bar .t{height:26px;background:var(--surface2);border-radius:6px;overflow:hidden}.bar .f{height:100%;border-radius:6px;background:#5a5859}
.bar.after .f{background:var(--grad)}.bar.c1 .f{background:var(--a1);opacity:.45}
.bar .num{font-family:var(--display);font-weight:700;font-size:16px;text-align:right}.bar .lab{font-size:13px;color:var(--muted)}
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
table.c{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;min-width:720px}
table.c th{font-family:var(--display);font-weight:600;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);text-align:right;padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
table.c th:nth-child(-n+3),table.c td:nth-child(-n+3){text-align:left}table.c td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:right}
table.c tr:last-child td{border-bottom:0}table.c tr.top td{background:var(--accent-soft)}table.c tr.tot td{font-weight:600;border-top:2px solid var(--line)}
table.c td a{color:inherit;text-decoration:none}table.c td a:hover{color:var(--a2)}
.fmt{font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid var(--line);color:var(--muted)}
.vbar{display:inline-block;height:6px;border-radius:3px;background:var(--grad);vertical-align:middle;margin-left:8px}
.tops{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.top-c{border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--surface);display:flex;flex-direction:column;gap:10px}
.top-c .rank{font-size:12px;color:var(--a2);font-weight:600}.top-c h3{font-size:19px;font-weight:700}
.kv{display:flex;flex-wrap:wrap;gap:14px;font-size:14px;color:var(--muted)}.kv b{color:var(--fg)}
.next{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.step{border-top:3px solid var(--accent);padding-top:14px;display:flex;flex-direction:column;gap:6px}
.step b{font-family:var(--display);font-size:17px;font-weight:700}.step span{color:var(--muted);font-size:14px}
.foot{font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:18px;display:flex;flex-direction:column;gap:6px}
body.editing [contenteditable],body.editing td,body.editing .v,body.editing h1,body.editing p,body.editing span,body.editing b{outline:1px dashed rgba(244,122,0,.35);outline-offset:2px}
@media (max-width:820px){.hero-nums{grid-template-columns:repeat(2,minmax(0,1fr))}.ba,.pair,.tops,.next,.changes{grid-template-columns:minmax(0,1fr)}.shot.before{max-width:360px}}
@media print{.btns,.slot{display:none}.wrap{gap:40px}section,.hero-nums,.card,.top-c{break-inside:avoid}}`;

function render(d: Awaited<ReturnType<typeof collect>>, ai: AiReport, since: number, until: number, model: string) {
  const byId = new Map(d.metrics.map((m) => [m.id, m]));
  const pick = (ids: string[], n: number, ok: (m: Metric) => boolean = () => true) => {
    const out: Metric[] = [];
    for (const id of ids) { const m = byId.get(id); if (m && ok(m) && !out.includes(m)) out.push(m); }
    for (const m of d.metrics) { if (out.length >= n) break; if (ok(m) && !out.includes(m)) out.push(m); }
    return out.slice(0, n);
  };
  const end = until - 1;
  const period = `${fmtDate(since)} a ${fmtDateY(end)}`;
  const monthName = new Date(since + (until - since) / 2).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
  const prevTxt = (m: Metric) => (m.onlyNow ? 'total hoje' : m.prev === null ? 'sem dado do período anterior' : `período anterior: ${fmtNum(m.prev, m.unit)}${pct(m.cur, m.prev) !== null ? ` (${fmtPct(pct(m.cur, m.prev))})` : ''}`);

  // Capa
  const hl = esc(ai.headline);
  const mark = ai.highlight && ai.headline.includes(ai.highlight) ? hl.replace(esc(ai.highlight), `<span class="tarja">${esc(ai.highlight)}</span>`) : hl;
  const chips = [
    d.spend !== null ? `Investimento em anúncios: ${fmtNum(d.spend, 'R$')}` : 'Sem anúncios no período',
    `${d.media.length} publicaç${d.media.length === 1 ? 'ão' : 'ões'} no período`,
    `Fonte: Meta (Instagram/Facebook), ${fmtDateY(Date.now())}`,
  ];
  // Números principais
  const hero = pick(ai.heroMetrics, 7);
  const heroHtml = hero.map((m, i) => `<div class="n${i === 0 ? ' big' : ''}"><span class="v">${fmtNum(m.cur, m.unit)}</span><span class="l">${esc(m.label)}</span><span class="s">${esc(prevTxt(m))}</span></div>`).join('');
  // Antes × agora
  const evo = pick(ai.evolutionMetrics, 4, (m) => m.prev !== null && !m.onlyNow);
  const rowsBefore = evo.map((m) => `<tr><td>${esc(m.label)}</td><td>${fmtNum(m.prev, m.unit)}</td></tr>`).join('');
  const rowsNow = evo.map((m) => { const p = pct(m.cur, m.prev); return `<tr><td>${esc(m.label)}</td><td class="${p === null ? '' : p >= 0 ? 'up' : 'down'}">${fmtNum(m.cur, m.unit)}${p !== null ? ` (${fmtPct(p)})` : ''}</td></tr>`; }).join('');
  const pA = `${fmtDate(since - 2 * d.len)}–${fmtDate(since - d.len - 1)}`;
  const pB = `${fmtDate(since - d.len)}–${fmtDate(since - 1)}`;
  const pC = `${fmtDate(since)}–${fmtDate(end)}`;
  // Comparativo por período (barras na mesma escala dentro de cada card)
  const per = pick(ai.periodMetrics, 3, (m) => m.cur !== null && m.prev !== null && m.prev2 !== null && !m.onlyNow);
  const perHtml = per.map((m) => {
    const vals = [m.prev2 ?? 0, m.prev ?? 0, m.cur ?? 0];
    const mx = Math.max(...vals, 1e-9);
    const cls = ['', ' c1', ' after'];
    const labs = ['Per. A', 'Per. B', 'Per. C'];
    return `<div class="card"><h3>${esc(m.label)}</h3><div class="mult">${fmtNum(m.cur, m.unit)}</div><div class="bars">${vals.map((v, i) => `<div class="bar${cls[i]}"><span class="lab">${labs[i]}</span><div class="t"><div class="f" style="width:${Math.max(2, Math.round((v / mx) * 100))}%"></div></div><span class="num">${fmtNum(v, m.unit)}</span></div>`).join('')}</div></div>`;
  }).join('');
  // Destaques: posts escolhidos pela IA (só os que existem); se faltar, os de mais visualizações.
  const mediaById = new Map(d.media.map((m) => [m.id, m]));
  const score = (m: MediaRow) => m.views ?? m.reach ?? m.interactions ?? (m.likes ?? 0) + (m.comments ?? 0);
  const tops: { m: MediaRow; title: string }[] = [];
  for (const h of ai.highlights ?? []) { const m = mediaById.get(h.mediaId); if (m && !tops.some((t) => t.m === m)) tops.push({ m, title: h.title }); }
  for (const m of [...d.media].sort((a, b) => score(b) - score(a))) { if (tops.length >= 3) break; if (!tops.some((t) => t.m === m)) tops.push({ m, title: m.caption.slice(0, 60) || '(sem legenda)' }); }
  const kv = (m: MediaRow) => [[m.views, 'visualizações'], [m.reach, 'contas alcançadas'], [m.interactions, 'interações'], [m.likes, 'curtidas'], [m.shares, 'compartilhamentos']].filter(([v]) => v !== null).slice(0, 3).map(([v, l]) => `<span><b>${fmtNum(v as number)}</b> ${l}</span>`).join('');
  const topsHtml = tops.slice(0, 3).map((t, i) => `<div class="top-c"><span class="rank">${i + 1}º · ${esc(t.m.format)} · ${t.m.date}</span><h3>${esc(t.title)}</h3><div class="kv">${kv(t.m)}</div></div>`).join('');
  // Detalhamento
  const mxV = Math.max(1, ...d.media.map((m) => m.views ?? 0));
  const tot = [0, 0, 0, 0, 0, 0];
  const cell = (v: number | null) => (v === null ? '—' : fmtNum(v));
  const tableRows = d.media.map((m) => {
    [m.views, m.reach, m.interactions, m.likes, m.comments, m.shares].forEach((v, i) => (tot[i] += v ?? 0));
    const name = esc(m.caption.slice(0, 70) || '(sem legenda)') + (m.source === 'manual' ? ' <span class="fmt">importado</span>' : '');
    return `<tr${(m.views ?? 0) > 1000 ? ' class="top"' : ''}><td>${m.date}</td><td><span class="fmt">${esc(m.format)}</span></td><td>${m.permalink ? `<a href="${esc(m.permalink)}" target="_blank" rel="noreferrer">${name}</a>` : name}</td><td>${cell(m.views)}${m.views ? `<span class="vbar" style="width:${Math.round((m.views / mxV) * 60)}px"></span>` : ''}</td><td>${cell(m.reach)}</td><td>${cell(m.interactions)}</td><td>${cell(m.likes)}</td><td>${cell(m.comments)}</td><td>${cell(m.shares)}</td></tr>`;
  }).join('');
  const totRow = `<tr class="tot"><td></td><td></td><td>Total (${d.media.length} entrega${d.media.length === 1 ? '' : 's'})</td>${tot.map((v) => `<td>${fmtNum(v)}</td>`).join('')}</tr>`;
  const changes = (ai.changes ?? []).slice(0, 4).map((c) => `<div class="ch"><b>${esc(c.title)}</b><span>${rich(c.text)}</span></div>`).join('');
  const steps = (ai.nextSteps ?? []).slice(0, 3).map((s) => `<div class="step"><b>${esc(s.title)}</b><span>${rich(s.text)}</span></div>`).join('');
  const who = d.handle ? `@${d.handle}` : d.brand.name;

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório ${esc(d.brand.name)} · ${esc(period)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap">
<style>${CSS}</style></head><body>
<div class="wrap">
<div class="topbar">${logo() ? `<img src="${logo()}" alt="GDR Gestão de Resultados">` : '<b>GDR Gestão de Resultados</b>'}<div class="btns"><button class="btn" id="edit">Editar textos</button><button class="btn on" onclick="window.print()">Salvar em PDF</button></div></div>

<header class="cover">
  <span class="eyebrow">Relatório de resultados · ${esc(monthName)} · ${esc(who)} · ${esc(period)}</span>
  <h1>${mark}</h1>
  <p class="lede">${rich(ai.summary)}</p>
  <div class="meta">${chips.map((c, i) => `<span class="chip${i === 0 ? ' on' : ''}">${esc(c)}</span>`).join('')}</div>
</header>

<section aria-label="Números principais">
  <div class="hero-nums">${heroHtml}</div>
  <p class="note">${rich(ai.heroNote)}</p>
</section>

${evo.length ? `<section>
  <div class="sec-head"><span class="eyebrow">Antes × Agora</span><h2>${esc(ai.evolutionTitle)}</h2><p>${rich(ai.evolutionContext)}</p></div>
  <div class="ba">
    <div class="shot before"><span class="tag">Antes · ${pB}</span><div class="frame"><div class="slot"><b>Inserir print do ANTES</b>Clique ou arraste a imagem aqui</div></div><table class="cmp">${rowsBefore}</table></div>
    <div class="shot now"><span class="tag">Agora · ${pC}</span><div class="frame"><div class="slot"><b>Inserir print do AGORA</b>Clique ou arraste a imagem aqui</div></div><table class="cmp">${rowsNow}</table></div>
  </div>
  ${changes ? `<div class="changes">${changes}</div>` : ''}
</section>` : ''}

${per.length ? `<section>
  <div class="sec-head"><span class="eyebrow">Comparativo por período</span><h2>${pA} × ${pB} × ${pC}</h2><p>${rich(ai.periodsText)} Barras na mesma escala dentro de cada card (maior valor = 100%).</p></div>
  <div class="pair">${perHtml}</div>
  <p class="note">${rich(ai.periodsNote)}</p>
</section>` : ''}

${topsHtml ? `<section>
  <div class="sec-head"><span class="eyebrow">Destaques</span><h2>${esc(ai.highlightsTitle)}</h2></div>
  <div class="tops">${topsHtml}</div>
  <p class="note">${rich(ai.highlightsNote)}</p>
</section>` : ''}

<section>
  <div class="sec-head"><span class="eyebrow">Detalhamento</span><h2>Todas as entregas de ${fmtDate(since)} a ${fmtDate(end)}</h2></div>
  <div class="tbl"><table class="c">
    <thead><tr><th>Data</th><th>Formato</th><th>Conteúdo / campanha</th><th>Visualizações</th><th>Contas</th><th>Interações</th><th>Curtidas</th><th>Coment.</th><th>Compart.</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="9">Nenhuma publicação sincronizada no período.</td></tr>'}${d.media.length ? totRow : ''}</tbody>
  </table></div>
  <p class="note">${rich(ai.tableNote)} "—" = métrica que a rede não forneceu (não é zero). Linhas com mais de 1.000 visualizações ficam destacadas.</p>
</section>

<section>
  <div class="sec-head"><span class="eyebrow">Leitura honesta e próximos passos</span><h2>O que vem agora</h2><p>${rich(ai.honest)}</p></div>
  <div class="next">${steps}</div>
</section>

<footer class="foot">
  <span>Dados coletados na Meta (Instagram/Facebook${d.spend !== null ? ' e Gerenciador de Anúncios' : ''}) em ${fmtDateY(Date.now())}, período de ${esc(period)}. Comparações com períodos anteriores de mesma duração (Per. A ${pA}, Per. B ${pB}, Per. C ${pC}).${d.problems.length ? ` Dados indisponíveis: ${esc(d.problems.join('; '))}.` : ''}</span>
  <span>Preparado por GDR Gestão de Resultados · textos gerados com ${esc(model)} a partir dos dados acima e revisáveis antes do envio.</span>
</footer>
</div>
<script>
document.querySelectorAll('.frame').forEach(fr=>{const slot=fr.querySelector('.slot');const inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.hidden=true;fr.appendChild(inp);
const load=f=>{if(!f||!f.type.startsWith('image/'))return;const r=new FileReader();r.onload=()=>{let im=fr.querySelector('img');if(!im){im=document.createElement('img');fr.appendChild(im)}im.src=r.result;if(slot)slot.style.display='none'};r.readAsDataURL(f)};
fr.addEventListener('click',()=>{if(!document.body.classList.contains('editing'))inp.click()});inp.addEventListener('change',()=>load(inp.files[0]));
fr.addEventListener('dragover',e=>e.preventDefault());fr.addEventListener('drop',e=>{e.preventDefault();load(e.dataTransfer.files[0])})});
const eb=document.getElementById('edit');eb.addEventListener('click',()=>{const on=!document.body.classList.contains('editing');document.body.classList.toggle('editing',on);eb.classList.toggle('on',on);eb.textContent=on?'Concluir edição':'Editar textos';try{document.designMode=on?'on':'off'}catch(e){}});
</script>
</body></html>`;
}

// ---------- job e rotas ----------

export async function reportHandler(ctx: JobContext) {
  const { brandId, since, until } = ctx.payload as { brandId: string; since: number; until: number };
  ctx.progress(0.05, 'Coletando os dados na Meta');
  const d = await collect(brandId, since, until);
  if (!d.metrics.some((m) => m.id !== 'posts.count') && !d.media.length) throw new Error(`Sem dados para o período: nenhum perfil com métricas e nenhuma publicação sincronizada.${d.problems.length ? ` (${d.problems.join('; ')})` : ''} Conecte os perfis e clique em "Atualizar dados" em Resultados.`);
  const provider = pickProvider();
  ctx.progress(0.35, 'O Claude está lendo os dados e escrevendo o relatório');
  const facts = {
    marca: d.brand.name, perfil: d.handle, periodo: { inicio: new Date(since).toISOString().slice(0, 10), fim: new Date(until - 1).toISOString().slice(0, 10), dias: Math.round(d.len / DAY) },
    periodos: { A: 'dois períodos antes (mesma duração)', B: 'período anterior (mesma duração)', C: 'período do relatório' },
    metricas: d.metrics.map((m) => ({ id: m.id, nome: m.label, atual: m.cur, anterior: m.prev, A: m.prev2, unidade: m.unit ?? null, observacao: m.onlyNow ? 'valor de hoje, sem comparação' : undefined })),
    posts: d.media.map((m) => ({ id: m.id, data: m.postedAt.slice(0, 10), formato: m.format, rede: m.network, legenda: m.caption.slice(0, 220), visualizacoes: m.views, alcance: m.reach, interacoes: m.interactions, curtidas: m.likes, comentarios: m.comments, compartilhamentos: m.shares, salvamentos: m.saves, origem: m.source === 'manual' ? 'planilha importada' : 'Meta' })),
    investimentoAnuncios: d.spend,
    dadosIndisponiveis: d.problems,
  };
  const res = await generateJson<AiReport>({ system: SYSTEM, prompt: `Dados do período (JSON):\n${JSON.stringify(facts)}\n\nEscreva o relatório seguindo as regras.`, schema: SCHEMA, maxTokens: 8000 }, provider);
  ctx.progress(0.9, 'Montando o relatório no modelo GDR');
  const html = render(d, res.data, since, until, res.model);
  const id = uid('rp_');
  const title = `${d.brand.name} · ${fmtDate(since)} a ${fmtDateY(until - 1)}`;
  db.prepare('INSERT INTO reports (id, brand_id, since, until, title, html, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, brandId, new Date(since).toISOString(), new Date(until).toISOString(), title, html, res.model, now());
  ctx.progress(1, 'Relatório pronto');
  return { reportId: id };
}

export async function reportRoutes(app: FastifyInstance) {
  app.post('/api/reports/generate', async (req) => {
    const b = (req.body ?? {}) as { brandId?: string; since?: string; until?: string };
    const since = Date.parse(String(b.since));
    const until = Date.parse(String(b.until));
    if (!b.brandId || !db.prepare('SELECT 1 FROM brands WHERE id = ?').get(b.brandId)) throw badRequest('Escolha a marca no topo.');
    if (!isFinite(since) || !isFinite(until) || until <= since) throw badRequest('Período inválido.', 'Escolha as datas "De" e "Até" em Resultados.');
    if (until - since > 93 * DAY) throw badRequest('O relatório aceita até 3 meses.', 'Escolha um período menor (o comparativo usa os 2 períodos anteriores de mesma duração).');
    pickProvider();
    const brand = db.prepare('SELECT name FROM brands WHERE id = ?').get(b.brandId) as any;
    return { jobId: enqueue({ type: 'report', title: `Relatório · ${brand.name}`, brandId: b.brandId, payload: { brandId: b.brandId, since, until } }) };
  });

  app.get('/api/reports', async (req) => {
    const { brandId } = req.query as { brandId?: string };
    return (db.prepare('SELECT id, brand_id, since, until, title, model, created_at FROM reports WHERE brand_id = ? ORDER BY created_at DESC LIMIT 30').all(brandId ?? '') as any[]).map((r) => ({ id: r.id, brandId: r.brand_id, since: r.since, until: r.until, title: r.title, model: r.model, createdAt: r.created_at }));
  });

  app.get('/api/reports/:id/view', async (req, reply) => {
    const r = db.prepare('SELECT html FROM reports WHERE id = ?').get((req.params as any).id) as any;
    if (!r) throw new AppError(404, 'Relatório não encontrado.', 'Ele pode ter sido excluído. Gere de novo em Resultados.');
    return reply.type('text/html; charset=utf-8').send(r.html);
  });

  app.delete('/api/reports/:id', async (req) => {
    db.prepare('DELETE FROM reports WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });
}
