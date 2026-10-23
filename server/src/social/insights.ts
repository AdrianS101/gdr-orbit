// Métricas reais via Graph API da Meta: totais da conta por período, conteúdos com métricas por post
// e resultados de anúncios (tráfego pago). Métricas que a Meta não fornece para a conta ficam marcadas
// como indisponíveis — nunca são estimadas.
import { db, getSetting, now } from '../db.ts';
import { unseal } from '../lib/vault.ts';
import { uid } from '../../../shared/timeline.ts';
import { graphVersion, MetaError } from './meta.ts';
import type { JobContext } from '../jobs/queue.ts';
import { metaFetch } from './meta-guard.ts';

const G = () => `https://graph.facebook.com/${graphVersion()}`;
const DAY = 86400;

async function get(path: string, params: Record<string, string>, token: string): Promise<any> {
  const r = await metaFetch(`${G()}/${path}?${new URLSearchParams({ ...params, access_token: token })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error ?? {};
    if (e.code === 190) throw new MetaError('A conexão com a Meta expirou.', 'Reconecte em Marcas → Perfis sociais.');
    if (e.code === 10 || e.code === 200) throw new MetaError(`Permissão de métricas não concedida (${e.message}).`, 'Reconecte o perfil aceitando as permissões de insights.');
    if (e.code === 4 || e.code === 17 || e.code === 613) throw new MetaError('Limite de consultas da Meta atingido.', 'Aguarde alguns minutos.');
    throw new MetaError(String(e.message ?? `HTTP ${r.status}`));
  }
  return j;
}

/** Divide [since, until] em janelas de até 30 dias (limite da API). */
function windows(since: number, until: number) {
  const out: [number, number][] = [];
  for (let a = since; a < until; a += 30 * DAY) out.push([a, Math.min(until, a + 30 * DAY)]);
  return out;
}

export const IG_ACCOUNT_METRICS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'profile_views', 'follows_and_unfollows', 'website_clicks'];

/** Totais da conta do Instagram no período (cada métrica pedida separadamente para tolerar indisponíveis). */
async function igTotals(igId: string, token: string, since: number, until: number) {
  const totals: Record<string, number | null> = {};
  const notes: string[] = [];
  const wins = windows(since, until);
  for (const m of IG_ACCOUNT_METRICS) {
    let sum = 0;
    try {
      for (const [a, b] of wins) {
        const j = await get(`${igId}/insights`, { metric: m, period: 'day', metric_type: 'total_value', since: String(a), until: String(b) }, token);
        const tv = j.data?.[0]?.total_value;
        sum += m === 'follows_and_unfollows' ? Number(tv?.breakdowns?.[0]?.results?.find((x: any) => x.dimension_values?.[0] === 'FOLLOWER')?.value ?? tv?.value ?? 0) : Number(tv?.value ?? 0);
      }
      totals[m] = sum;
    } catch {
      totals[m] = null;
    }
  }
  if (wins.length > 1) notes.push('Alcance e contas engajadas são somas de janelas de 30 dias (a Meta não entrega valor único acima de 30 dias); pessoas podem se repetir entre janelas.');
  try {
    totals.followers_now = Number((await get(igId, { fields: 'followers_count' }, token)).followers_count);
  } catch {
    totals.followers_now = null;
  }
  return { totals, notes };
}

const FB_PAGE_METRICS = ['page_impressions_unique', 'page_post_engagements', 'page_views_total', 'page_daily_follows_unique', 'page_video_views'];

async function fbTotals(pageId: string, token: string, since: number, until: number) {
  const totals: Record<string, number | null> = {};
  for (const m of FB_PAGE_METRICS) {
    try {
      let sum = 0;
      for (const [a, b] of windows(since, until)) {
        const j = await get(`${pageId}/insights`, { metric: m, period: 'day', since: String(a), until: String(b) }, token);
        sum += (j.data?.[0]?.values ?? []).reduce((n: number, v: any) => n + (Number(v.value) || 0), 0);
      }
      totals[m] = sum;
    } catch {
      totals[m] = null;
    }
  }
  try {
    totals.followers_now = Number((await get(pageId, { fields: 'followers_count' }, token)).followers_count);
  } catch {
    totals.followers_now = null;
  }
  return { totals, notes: [] as string[] };
}

/** Totais com cache de 1 hora (a Meta atualiza insights com atraso; não são em tempo real). */
export async function accountTotals(acc: any, since: number, until: number) {
  const key = `tot:${acc.id}:${since}:${until}`;
  const c = db.prepare('SELECT data, fetched_at FROM insight_cache WHERE key = ?').get(key) as any;
  if (c && Date.now() - Date.parse(c.fetched_at) < 3600_000) return { ...JSON.parse(c.data), fetchedAt: c.fetched_at };
  const token = unseal(acc.token);
  const r = acc.network === 'instagram' ? await igTotals(acc.external_id, token, since, until) : await fbTotals(acc.external_id, token, since, until);
  db.prepare('INSERT INTO insight_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at').run(key, JSON.stringify(r), now());
  return { ...r, fetchedAt: now() };
}

// ---------- conteúdos ----------

const IG_MEDIA_METRICS: Record<string, string[]> = {
  REELS: ['views', 'reach', 'saved', 'shares', 'total_interactions', 'likes', 'comments', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'],
  FEED: ['views', 'reach', 'saved', 'shares', 'total_interactions', 'likes', 'comments'],
};

async function mediaInsights(id: string, product: string, token: string) {
  const list = IG_MEDIA_METRICS[product === 'REELS' ? 'REELS' : 'FEED'];
  const out: Record<string, number> = {};
  try {
    const j = await get(`${id}/insights`, { metric: list.join(',') }, token);
    for (const d of j.data ?? []) out[d.name] = Number(d.values?.[0]?.value ?? d.total_value?.value ?? 0);
  } catch (e) {
    // Sem permissão de métricas: não adianta tentar métrica por métrica — avisa para reconectar.
    if (e instanceof MetaError && /Permissão/.test(e.message)) throw e;
    for (const m of list) {
      try {
        const j = await get(`${id}/insights`, { metric: m }, token);
        out[m] = Number(j.data?.[0]?.values?.[0]?.value ?? 0);
      } catch {
        /* métrica indisponível para este post */
      }
    }
  }
  return out;
}

function upsertMedia(accId: string, network: string, m: { external_id: string; type: string; caption: string; permalink: string; thumb: string | null; posted_at: string; metrics: any }) {
  db.prepare(
    `INSERT INTO media_items (id, account_id, network, external_id, type, caption, permalink, thumb, posted_at, metrics, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, external_id) DO UPDATE SET caption = excluded.caption, thumb = excluded.thumb, metrics = excluded.metrics, updated_at = excluded.updated_at`,
  ).run(uid('mi_'), accId, network, m.external_id, m.type, m.caption, m.permalink, m.thumb, m.posted_at, JSON.stringify(m.metrics), now());
}

export async function syncMedia(acc: any, days: number, onStep: (msg: string) => void) {
  const token = unseal(acc.token);
  const since = Date.now() - days * DAY * 1000;
  let n = 0;
  let noPermission = false;
  if (acc.network === 'instagram') {
    let url: string | null = `${G()}/${acc.external_id}/media?${new URLSearchParams({ fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: '50', access_token: token })}`;
    while (url) {
      const j: any = await (await metaFetch(url)).json();
      if (j.error) throw new MetaError(j.error.message);
      for (const m of j.data ?? []) {
        if (Date.parse(m.timestamp) < since) {
          url = null;
          break;
        }
        onStep(`Instagram: post ${++n}`);
        let metrics: Record<string, number> = {};
        if (!noPermission) {
          try {
            metrics = await mediaInsights(m.id, m.media_product_type, token);
          } catch (e) {
            if (e instanceof MetaError && /Permissão/.test(e.message)) noPermission = true;
            else throw e;
          }
        }
        metrics.likes ??= m.like_count;
        metrics.comments ??= m.comments_count;
        upsertMedia(acc.id, 'instagram', { external_id: m.id, type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'image', caption: m.caption ?? '', permalink: m.permalink, thumb: m.thumbnail_url ?? m.media_url ?? null, posted_at: m.timestamp, metrics });
      }
      if (url) url = j.paging?.next ?? null;
    }
  } else {
    const j = await get(`${acc.external_id}/published_posts`, { fields: 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', since: String(Math.floor(since / 1000)), limit: '100' }, token);
    for (const p of j.data ?? []) {
      onStep(`Facebook: post ${++n}`);
      const metrics: Record<string, number> = { reactions: p.reactions?.summary?.total_count ?? 0, comments: p.comments?.summary?.total_count ?? 0, shares: p.shares?.count ?? 0 };
      for (const m of ['post_impressions_unique', 'post_clicks', 'post_video_views']) {
        try {
          const ins = await get(`${p.id}/insights`, { metric: m }, token);
          metrics[m] = Number(ins.data?.[0]?.values?.[0]?.value ?? 0);
        } catch {
          /* indisponível */
        }
      }
      upsertMedia(acc.id, 'facebook', { external_id: p.id, type: 'post', caption: p.message ?? '', permalink: p.permalink_url, thumb: p.full_picture ?? null, posted_at: p.created_time, metrics });
    }
  }
  // Registra (ou limpa) o aviso de permissão no perfil — exibido na tela de Resultados.
  db.prepare('UPDATE social_accounts SET error = ? WHERE id = ?').run(noPermission ? 'A Meta não liberou as métricas dos posts para esta conexão. Reconecte o perfil em Marcas → Perfis sociais aceitando a permissão de insights.' : null, acc.id);
  return n;
}

// ---------- tráfego pago ----------

function userToken(): string | null {
  const s = getSetting<string | null>('meta.userToken', null);
  return s ? unseal(s) : null;
}

export async function adAccounts() {
  const t = userToken();
  if (!t) throw new MetaError('Sem acesso às contas de anúncio.', 'Reconecte a Meta em Marcas → Perfis sociais aceitando a permissão de anúncios.');
  const j = await get('me/adaccounts', { fields: 'id,name,account_status,currency', limit: '100' }, t);
  return (j.data ?? []).map((a: any) => ({ id: a.id, name: a.name, currency: a.currency, active: a.account_status === 1 }));
}

const RESULT_ACTIONS = ['onsite_conversion.messaging_conversation_started_7d', 'lead', 'link_click', 'purchase', 'video_view', 'post_engagement', 'onsite_conversion.lead_grouped'];

/** Anúncios do período com métricas e o post do Instagram/Facebook promovido (quando houver). */
export async function adsReport(adAccountId: string, since: string, until: string) {
  const key = `ads:${adAccountId}:${since}:${until}`;
  const c = db.prepare('SELECT data, fetched_at FROM insight_cache WHERE key = ?').get(key) as any;
  if (c && Date.now() - Date.parse(c.fetched_at) < 3600_000) return { items: JSON.parse(c.data), fetchedAt: c.fetched_at };
  const t = userToken();
  if (!t) throw new MetaError('Sem acesso às contas de anúncio.', 'Reconecte a Meta aceitando a permissão de anúncios.');
  const ins = await get(`${adAccountId}/insights`, { level: 'ad', fields: 'ad_id,ad_name,campaign_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions', time_range: JSON.stringify({ since, until }), limit: '200' }, t);
  const items = [];
  for (const r of ins.data ?? []) {
    let mediaId: string | null = null;
    let storyId: string | null = null;
    try {
      const ad = await get(r.ad_id, { fields: 'creative{effective_instagram_media_id,effective_object_story_id}' }, t);
      mediaId = ad.creative?.effective_instagram_media_id ?? null;
      storyId = ad.creative?.effective_object_story_id ?? null;
    } catch {
      /* criativo sem post vinculado */
    }
    const actions: Record<string, number> = {};
    for (const a of r.actions ?? []) if (RESULT_ACTIONS.includes(a.action_type)) actions[a.action_type] = Number(a.value);
    items.push({ adId: r.ad_id, name: r.ad_name, campaign: r.campaign_name, spend: Number(r.spend), impressions: Number(r.impressions), reach: Number(r.reach), clicks: Number(r.clicks), ctr: Number(r.ctr), cpc: Number(r.cpc ?? 0), cpm: Number(r.cpm ?? 0), actions, mediaId, storyId });
  }
  db.prepare('INSERT INTO insight_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at').run(key, JSON.stringify(items), now());
  return { items, fetchedAt: now() };
}

export async function metricsHandler(ctx: JobContext) {
  const { brandId, days = 90 } = ctx.payload as { brandId: string; days?: number };
  const accs = db.prepare("SELECT * FROM social_accounts WHERE brand_id = ? AND network IN ('instagram','facebook') AND token IS NOT NULL").all(brandId) as any[];
  if (!accs.length) throw new Error('Nenhum perfil do Instagram/Facebook conectado a esta marca.');
  let total = 0;
  const errors: string[] = [];
  for (const [i, a] of accs.entries()) {
    try {
      total += await syncMedia(a, days, (m) => ctx.progress((i + 0.5) / accs.length, `${a.username ?? a.name}: ${m}`));
    } catch (e) {
      errors.push(`${a.username ?? a.name}: ${(e as Error).message}`);
    }
  }
  db.prepare("DELETE FROM insight_cache WHERE key LIKE 'tot:%' OR key LIKE 'ads:%'").run();
  if (errors.length && !total) throw new Error(errors.join(' | '));
  return { posts: total, errors };
}
