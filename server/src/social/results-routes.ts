// Resultados: totais por perfil (período e período anterior), ranking de conteúdos, tráfego pago e exportação.
import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting } from '../db.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { enqueue } from '../jobs/queue.ts';
import { accountTotals, adAccounts, adsReport } from './insights.ts';
import { MetaError } from './meta.ts';

function range(q: any) {
  const since = Date.parse(String(q.since));
  const until = Date.parse(String(q.until));
  if (!isFinite(since) || !isFinite(until) || until <= since) throw badRequest('Período inválido.');
  if (until - since > 366 * 86400_000) throw badRequest('Escolha um período de até 1 ano.');
  return { since, until };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function resultsRoutes(app: FastifyInstance) {
  app.post('/api/results/sync', async (req) => {
    const { brandId, days } = (req.body ?? {}) as { brandId: string; days?: number };
    return { jobId: enqueue({ type: 'metrics', title: 'Atualizando métricas', brandId, payload: { brandId, days: Math.min(365, Number(days) || 90) } }) };
  });

  app.get('/api/results', async (req) => {
    const q = req.query as any;
    const { since, until } = range(q);
    const len = until - since;
    const accounts = db.prepare("SELECT * FROM social_accounts WHERE brand_id = ? AND network IN ('instagram','facebook') AND token IS NOT NULL").all(q.brandId) as any[];
    const out = [];
    for (const a of accounts) {
      try {
        const cur = await accountTotals(a, Math.floor(since / 1000), Math.floor(until / 1000));
        const prev = await accountTotals(a, Math.floor((since - len) / 1000), Math.floor(since / 1000));
        const allNull = Object.entries(cur.totals).every(([k, v]) => k === 'followers_now' || v === null);
        out.push({ id: a.id, network: a.network, name: a.username ?? a.name, avatar: a.avatar, totals: cur.totals, prev: prev.totals, notes: cur.notes, fetchedAt: cur.fetchedAt, error: null, warning: a.error ?? (allNull ? 'A Meta não entregou as métricas da conta para esta conexão. Reconecte o perfil em Marcas → Perfis sociais aceitando as permissões de insights.' : null) });
      } catch (e) {
        out.push({ id: a.id, network: a.network, name: a.username ?? a.name, avatar: a.avatar, totals: {}, prev: {}, notes: [], fetchedAt: null, error: e instanceof MetaError ? `${e.message} ${e.hint}` : (e as Error).message });
      }
    }
    const ids = accounts.map((a) => a.id);
    const media = ids.length
      ? (db.prepare(`SELECT m.*, a.username, a.name AS account_name FROM media_items m JOIN social_accounts a ON a.id = m.account_id WHERE m.account_id IN (${ids.map(() => '?').join(',')}) AND m.posted_at >= ? AND m.posted_at < ? ORDER BY m.posted_at DESC`).all(...ids, new Date(since).toISOString(), new Date(until).toISOString()) as any[]).map((m) => ({
          id: m.id, externalId: m.external_id, network: m.network, type: m.type, caption: m.caption, permalink: m.permalink, thumb: m.thumb, postedAt: m.posted_at, metrics: JSON.parse(m.metrics), updatedAt: m.updated_at, account: m.username ?? m.account_name,
        }))
      : [];
    // Tráfego pago (se a marca tiver conta de anúncio escolhida)
    const adAccount = getSetting<string | null>(`brand.adAccount.${q.brandId}`, null);
    let ads: any = { configured: !!adAccount, items: [], error: null, fetchedAt: null };
    if (adAccount) {
      try {
        const r = await adsReport(adAccount, day(since), day(until - 1));
        ads = { configured: true, adAccount, items: r.items, fetchedAt: r.fetchedAt, error: null };
      } catch (e) {
        ads.error = e instanceof MetaError ? `${e.message} ${e.hint}` : (e as Error).message;
      }
    }
    const lastSync = ids.length ? (db.prepare(`SELECT MAX(updated_at) AS t FROM media_items WHERE account_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as any).t : null;
    return { accounts: out, media, ads, lastSync };
  });

  app.get('/api/results/ad-accounts', async () => {
    try {
      return await adAccounts();
    } catch (e) {
      if (e instanceof MetaError) throw new AppError(400, e.message, e.hint);
      throw e;
    }
  });

  app.put('/api/results/ad-account', async (req) => {
    const { brandId, adAccountId } = (req.body ?? {}) as { brandId: string; adAccountId: string | null };
    if (adAccountId && !/^act_\d+$/.test(adAccountId)) throw badRequest('Conta de anúncio inválida.');
    setSetting(`brand.adAccount.${brandId}`, adAccountId || null);
    return { ok: true };
  });
}
