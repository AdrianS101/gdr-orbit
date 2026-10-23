// Resultados: totais por perfil (período e período anterior), ranking de conteúdos, tráfego pago e exportação.
import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting } from '../db.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { enqueue } from '../jobs/queue.ts';
import { accountTotals, adAccounts, adsReport } from './insights.ts';
import { MetaError } from './meta.ts';
import { parseMetricsCsv } from '../../../shared/metrics-import.ts';
import { uid } from '../../../shared/timeline.ts';
import crypto from 'node:crypto';
import { now } from '../db.ts';

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
    // Contas com métricas importadas manualmente (ex.: TikTok) também entram no ranking, identificadas.
    const manual = db.prepare("SELECT DISTINCT account_id FROM media_items m JOIN social_accounts a ON a.id = m.account_id WHERE a.brand_id = ? AND m.source = 'manual'").all(q.brandId) as any[];
    const ids = Array.from(new Set([...accounts.map((a) => a.id), ...manual.map((m) => m.account_id)]));
    const media = ids.length
      ? (db.prepare(`SELECT m.*, a.username, a.name AS account_name FROM media_items m JOIN social_accounts a ON a.id = m.account_id WHERE m.account_id IN (${ids.map(() => '?').join(',')}) AND m.posted_at >= ? AND m.posted_at < ? ORDER BY m.posted_at DESC`).all(...ids, new Date(since).toISOString(), new Date(until).toISOString()) as any[]).map((m) => ({
          id: m.id, externalId: m.external_id, network: m.network, type: m.type, caption: m.caption, permalink: m.permalink, thumb: m.thumb, postedAt: m.posted_at, metrics: JSON.parse(m.metrics), updatedAt: m.updated_at, account: m.username ?? m.account_name, source: m.source, importBatch: m.import_batch,
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
    const imports = (db.prepare('SELECT i.*, a.network, a.username, a.name FROM metric_imports i JOIN social_accounts a ON a.id = i.account_id WHERE i.brand_id = ? ORDER BY i.created_at DESC').all(q.brandId) as any[]).map((i) => ({ id: i.id, file: i.file, rows: i.rows, network: i.network, profile: i.username ?? i.name, createdAt: i.created_at }));
    return { accounts: out, media, ads, lastSync, imports };
  });

  // ---- importação manual (CSV) ----
  app.post('/api/results/import', async (req) => {
    const b = (req.body ?? {}) as { brandId: string; network: string; profile: string; file: string; csv: string; dryRun?: boolean };
    if (!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(b.brandId)) throw badRequest('Escolha a marca.');
    const net = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin'].includes(b.network) ? b.network : null;
    if (!net) throw badRequest('Escolha a rede dos dados.');
    const profile = String(b.profile ?? '').trim().replace(/^@/, '');
    if (!profile) throw badRequest('Informe o perfil (@) a que os números pertencem.');
    const parsed = parseMetricsCsv(String(b.csv ?? ''));
    if (b.dryRun || !parsed.rows.length) return { ...parsed, imported: 0 };
    let acc = db.prepare('SELECT * FROM social_accounts WHERE brand_id = ? AND network = ? AND (username = ? OR name = ?)').get(b.brandId, net, profile, profile) as any;
    if (!acc) {
      const id = uid('sa_');
      db.prepare("INSERT INTO social_accounts (id, brand_id, network, external_id, name, username, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)").run(id, b.brandId, net, `manual:${profile}`, profile, profile, now());
      acc = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id);
    }
    const batch = uid('mi_');
    const up = db.prepare("INSERT INTO media_items (id, account_id, network, external_id, type, caption, permalink, posted_at, metrics, updated_at, source, import_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?) ON CONFLICT(account_id, external_id) DO UPDATE SET type = excluded.type, caption = excluded.caption, permalink = excluded.permalink, posted_at = excluded.posted_at, metrics = excluded.metrics, updated_at = excluded.updated_at, source = 'manual', import_batch = excluded.import_batch");
    for (const r of parsed.rows) {
      const key = 'manual:' + crypto.createHash('sha1').update(r.link || `${r.postedAt}|${r.caption}`).digest('hex').slice(0, 16);
      up.run(uid('mx_'), acc.id, net, key, r.type, r.caption, r.link, r.postedAt, JSON.stringify(r.metrics), now(), batch);
    }
    db.prepare('INSERT INTO metric_imports (id, brand_id, account_id, file, rows, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(batch, b.brandId, acc.id, String(b.file || 'planilha.csv').slice(0, 200), parsed.rows.length, now());
    return { ...parsed, imported: parsed.rows.length, batch };
  });

  app.delete('/api/results/import/:id', async (req) => {
    const id = (req.params as any).id;
    db.prepare("DELETE FROM media_items WHERE import_batch = ? AND source = 'manual'").run(id);
    db.prepare('DELETE FROM metric_imports WHERE id = ?').run(id);
    return { ok: true };
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
