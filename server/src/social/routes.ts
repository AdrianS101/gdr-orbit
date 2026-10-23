// Contas sociais por marca, posts (vídeo, imagem, carrossel), fluxo de status, agendamento e publicação.
// Fluxo: Rascunho → Em revisão → Aprovado → Agendado → Publicando → Publicado | Falhou | Aguardando publicação manual.
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db, now, setSetting } from '../db.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { assetPath, exportPath, jobTmp } from '../lib/storage.ts';
import { publicBase } from '../lib/http.ts';
import { seal, unseal } from '../lib/vault.ts';
import { readSecrets, setSecret } from '../ai/providers.ts';
import { enqueue, type JobContext } from '../jobs/queue.ts';
import { uid } from '../../../shared/timeline.ts';
import { metaFetch, recheckBlock } from './meta-guard.ts';
import { exchangeAndList, graphVersion, metaApp, MetaError, oauthUrl, publishFacebook, publishInstagram, verifyAccount, type MetaCandidate, type PublishFile } from './meta.ts';

const EDITABLE = ['draft', 'review', 'approved', 'failed'];
const pending = new Map<string, { brandId: string; at: number; candidates?: MetaCandidate[]; userToken?: string; expiresIn?: number | null; error?: string }>();

function rowToAccount(r: any) {
  return { id: r.id, brandId: r.brand_id, network: r.network, externalId: r.external_id, name: r.name, username: r.username, avatar: r.avatar, status: r.status, verifiedAt: r.verified_at, error: r.error, assisted: r.network === 'tiktok' };
}

function rowToPost(r: any) {
  const targets = (db.prepare('SELECT t.*, a.name AS account_name, a.username, a.avatar FROM post_targets t LEFT JOIN social_accounts a ON a.id = t.account_id WHERE t.post_id = ?').all(r.id) as any[]).map((t) => ({
    id: t.id, accountId: t.account_id, network: t.network, status: t.status, permalink: t.permalink, error: t.error, publishedAt: t.published_at, accountName: t.account_name, username: t.username, avatar: t.avatar,
  }));
  return { id: r.id, brandId: r.brand_id, projectId: r.project_id, type: r.type, media: JSON.parse(r.media), caption: r.caption, captions: JSON.parse(r.captions), status: r.status, scheduledAt: r.scheduled_at, timezone: r.timezone, cover: r.cover ? JSON.parse(r.cover) : null, createdAt: r.created_at, updatedAt: r.updated_at, targets };
}

/** Capa do Reels: um quadro do vídeo (segundos) ou uma imagem da Biblioteca da marca. */
function cleanCover(c: any, brandId: string, type: string): string | null {
  if (type !== 'video' || !c) return null;
  if (c.kind === 'frame' && Number.isFinite(Number(c.t))) return JSON.stringify({ kind: 'frame', t: Math.max(0, Number(c.t)) });
  if (c.kind === 'image') {
    const a = db.prepare("SELECT 1 FROM assets WHERE id = ? AND brand_id = ? AND kind = 'image'").get(c.assetId, brandId);
    if (!a) throw badRequest('A imagem de capa não está na Biblioteca desta marca.');
    return JSON.stringify({ kind: 'image', assetId: c.assetId });
  }
  return null;
}

function resolveMedia(brandId: string, media: { source: 'export' | 'asset'; id: string }[]): PublishFile[] {
  return media.map((m) => {
    if (m.source === 'export') {
      const e = db.prepare('SELECT * FROM exports WHERE id = ? AND brand_id = ?').get(m.id, brandId) as any;
      if (!e) throw new Error('Um vídeo exportado deste post não existe mais.');
      return { file: exportPath(e.brand_id, e.file), kind: 'video' as const };
    }
    const a = db.prepare('SELECT * FROM assets WHERE id = ? AND brand_id = ?').get(m.id, brandId) as any;
    if (!a || (a.kind !== 'image' && a.kind !== 'video')) throw new Error('Uma mídia deste post não está mais na biblioteca da marca.');
    return { file: assetPath(a.brand_id, a.id, 'original', a.ext), kind: a.kind };
  });
}

function validatePost(p: { type: string; media: any[]; targets: string[] }, brandId: string) {
  if (!['video', 'image', 'carousel'].includes(p.type)) throw badRequest('Tipo de post inválido.');
  if (!p.media.length) throw badRequest('Escolha a mídia do post.');
  if (p.type !== 'carousel' && p.media.length !== 1) throw badRequest('Esse tipo de post usa uma única mídia.');
  if (p.type === 'carousel' && (p.media.length < 2 || p.media.length > 10)) throw badRequest('O carrossel precisa ter de 2 a 10 itens.', 'Limite do Instagram.');
  resolveMedia(brandId, p.media).forEach((f) => {
    if (!fs.existsSync(f.file)) throw badRequest('Um arquivo do post não foi encontrado no armazenamento.');
  });
  for (const t of p.targets) {
    const a = db.prepare('SELECT network FROM social_accounts WHERE id = ? AND brand_id = ?').get(t, brandId) as any;
    if (!a) throw badRequest('Um perfil de destino não pertence a esta marca.');
    if (a.network === 'tiktok' && p.type !== 'video') throw badRequest('No TikTok este fluxo aceita apenas vídeo.');
  }
}

function setTargets(postId: string, targets: string[]) {
  const cur = db.prepare('SELECT account_id, status FROM post_targets WHERE post_id = ?').all(postId) as any[];
  for (const c of cur) if (!targets.includes(c.account_id) && c.status !== 'published') db.prepare('DELETE FROM post_targets WHERE post_id = ? AND account_id = ?').run(postId, c.account_id);
  for (const t of targets) {
    const a = db.prepare('SELECT network FROM social_accounts WHERE id = ?').get(t) as any;
    db.prepare('INSERT OR IGNORE INTO post_targets (id, post_id, account_id, network) VALUES (?, ?, ?, ?)').run(uid('pt_'), postId, t, a.network);
  }
}

// ---------- publicação (job) ----------

/** Capa: no Instagram, quadro = thumb_offset (ms) e imagem = cover_url; no Facebook vai sempre como arquivo de imagem (quadro extraído pelo FFmpeg). */
async function prepareCover(c: { kind: 'frame' | 'image'; t?: number; assetId?: string }, brandId: string, video: string, jobId: string): Promise<{ offsetMs?: number; frameFile?: string; imageFile?: string }> {
  if (c.kind === 'image') {
    const a = db.prepare("SELECT * FROM assets WHERE id = ? AND brand_id = ? AND kind = 'image'").get(c.assetId ?? '', brandId) as any;
    if (!a) throw new Error('A imagem de capa não está mais na Biblioteca.');
    return { imageFile: assetPath(a.brand_id, a.id, 'original', a.ext) };
  }
  const frameFile = path.join(jobTmp(jobId), 'capa.jpg');
  await runFfmpeg(['-y', '-ss', String(c.t ?? 0), '-i', video, '-frames:v', '1', '-q:v', '2', frameFile]);
  return { offsetMs: Math.round((c.t ?? 0) * 1000), frameFile };
}

export async function publishHandler(ctx: JobContext) {
  const { postId } = ctx.payload as { postId: string };
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as any;
  if (!post) throw new Error('O post foi excluído.');
  const files = resolveMedia(post.brand_id, JSON.parse(post.media));
  const captions = JSON.parse(post.captions);
  const cover = post.type === 'video' && post.cover ? await prepareCover(JSON.parse(post.cover), post.brand_id, files[0].file, ctx.job.id) : null;
  const targets = db.prepare("SELECT * FROM post_targets WHERE post_id = ? AND status != 'published'").all(postId) as any[];
  const errors: string[] = [];
  let i = 0;
  for (const t of targets) {
    i++;
    const acc = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(t.account_id) as any;
    if (!acc) {
      db.prepare("UPDATE post_targets SET status = 'failed', error = ? WHERE id = ?").run('Perfil removido.', t.id);
      errors.push('Perfil removido');
      continue;
    }
    if (acc.network === 'tiktok') {
      db.prepare("UPDATE post_targets SET status = 'manual' WHERE id = ?").run(t.id);
      continue;
    }
    const caption = captions[acc.network] || post.caption;
    const step = (msg: string, containerId?: string) => {
      ctx.progress((i - 1) / targets.length + 0.5 / targets.length, `${acc.name}: ${msg}`);
      if (containerId) db.prepare('UPDATE post_targets SET container_id = ? WHERE id = ?').run(containerId, t.id);
    };
    db.prepare("UPDATE post_targets SET status = 'publishing', attempts = attempts + 1, error = NULL WHERE id = ?").run(t.id);
    try {
      const token = unseal(acc.token);
      const r = acc.network === 'instagram' ? await publishInstagram({ igId: acc.external_id, pageId: acc.page_id, token }, post.type, files, caption, t.container_id, step, cover) : await publishFacebook({ pageId: acc.external_id, token }, post.type, files, caption, step, cover?.imageFile ?? cover?.frameFile);
      db.prepare("UPDATE post_targets SET status = 'published', external_id = ?, permalink = ?, published_at = ?, error = NULL WHERE id = ?").run(r.externalId, r.permalink, now(), t.id);
    } catch (e) {
      const msg = e instanceof MetaError ? `${e.message} ${e.hint}` : (e as Error).message;
      db.prepare("UPDATE post_targets SET status = 'failed', error = ? WHERE id = ?").run(msg, t.id);
      errors.push(`${acc.name}: ${msg}`);
    }
  }
  const all = db.prepare('SELECT status FROM post_targets WHERE post_id = ?').all(postId) as any[];
  const status = all.some((x) => x.status === 'failed') ? 'failed' : all.some((x) => x.status === 'manual') ? 'awaiting_manual' : 'published';
  db.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), postId);
  if (errors.length) throw new Error(errors.join(' | '));
  return { status };
}

/** Verifica posts agendados. Se o computador estava desligado no horário (>15 min), não publica sozinho. */
export function startScheduler() {
  const tick = () => {
    const due = db.prepare("SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?").all(now()) as any[];
    for (const p of due) {
      if (Date.now() - Date.parse(p.scheduled_at) > 15 * 60_000) {
        db.prepare("UPDATE posts SET status = 'failed', updated_at = ? WHERE id = ?").run(now(), p.id);
        db.prepare("UPDATE post_targets SET status = 'failed', error = 'O GDR Digital estava desligado no horário agendado. Reagende ou publique agora.' WHERE post_id = ? AND status = 'pending'").run(p.id);
        continue;
      }
      db.prepare("UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ?").run(now(), p.id);
      enqueue({ type: 'publish', title: 'Publicando post agendado', brandId: p.brand_id, payload: { postId: p.id } });
    }
  };
  setInterval(tick, 20_000).unref();
  tick();
}

export async function socialRoutes(app: FastifyInstance) {
  // ---- app da Meta ----
  app.get('/api/settings/meta', async (req) => ({ configured: !!metaApp(), appId: readSecrets().META_APP_ID ?? '', redirectUri: `${publicBase(req)}/api/social/meta/callback` }));
  app.put('/api/settings/meta', async (req) => {
    const { appId, appSecret } = (req.body ?? {}) as { appId?: string; appSecret?: string };
    if (!appId || !/^\d{6,25}$/.test(appId.trim())) throw badRequest('App ID inválido.', 'É o número mostrado no topo do painel do app em developers.facebook.com.');
    setSecret('META_APP_ID', appId.trim());
    if (appSecret) setSecret('META_APP_SECRET', appSecret.trim());
    return { ok: true };
  });

  // ---- contas ----
  app.get('/api/social/accounts', async (req) => {
    const { brandId } = req.query as { brandId?: string };
    return (brandId ? db.prepare("SELECT * FROM social_accounts WHERE brand_id = ? AND status != 'manual' ORDER BY network, name").all(brandId) : db.prepare("SELECT * FROM social_accounts WHERE status != 'manual' ORDER BY network, name").all()).map(rowToAccount);
  });

  app.get('/api/social/meta/connect', async (req, reply) => {
    const { brandId } = req.query as { brandId: string };
    if (!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(brandId)) throw notFound('Marca');
    const state = crypto.randomBytes(16).toString('hex');
    pending.set(state, { brandId, at: Date.now() });
    try {
      return reply.redirect(oauthUrl(`${publicBase(req)}/api/social/meta/callback`, state));
    } catch (e) {
      if (e instanceof MetaError) return reply.redirect(`/marcas/${brandId}?metaErro=${encodeURIComponent(e.message + ' ' + e.hint)}`);
      throw e;
    }
  });

  // Retorno do login da Meta (fora da sessão: validado pelo "state" de uso único criado acima).
  app.get('/api/social/meta/callback', async (req, reply) => {
    const { code, state, error_description } = req.query as Record<string, string>;
    const p = pending.get(state);
    if (!p || Date.now() - p.at > 15 * 60_000) return reply.redirect('/marcas?metaErro=' + encodeURIComponent('A conexão expirou. Tente conectar de novo.'));
    if (!code) {
      pending.delete(state);
      return reply.redirect(`/marcas/${p.brandId}?metaErro=${encodeURIComponent(error_description || 'Conexão cancelada.')}`);
    }
    try {
      const r = await exchangeAndList(code, `${publicBase(req)}/api/social/meta/callback`);
      p.candidates = r.candidates;
      p.userToken = r.userToken;
      p.expiresIn = r.expiresIn;
    } catch (e) {
      p.error = e instanceof MetaError ? `${e.message} ${e.hint}` : (e as Error).message;
    }
    return reply.redirect(`/marcas/${p.brandId}?meta=${state}`);
  });

  app.get('/api/social/meta/pending/:state', async (req) => {
    const p = pending.get((req.params as any).state);
    if (!p) throw new AppError(404, 'Esta conexão expirou.', 'Clique em "Conectar Instagram/Facebook" de novo.');
    if (p.error) throw new AppError(502, p.error, '');
    return (p.candidates ?? []).map((c) => ({ pageId: c.pageId, pageName: c.pageName, pagePicture: c.pagePicture, ig: c.ig }));
  });

  app.post('/api/social/meta/link', async (req) => {
    const { state, selections } = (req.body ?? {}) as { state: string; selections: { pageId: string; facebook: boolean; instagram: boolean }[] };
    const p = pending.get(state);
    if (!p?.candidates) throw new AppError(404, 'Esta conexão expirou.', 'Conecte de novo.');
    let linked = 0;
    for (const s of selections ?? []) {
      const c = p.candidates.find((x) => x.pageId === s.pageId);
      if (!c) continue;
      const add = async (network: 'facebook' | 'instagram', externalId: string, name: string, username: string | null, avatar: string | null) => {
        await verifyAccount(network, externalId, c.pageToken);
        db.prepare(
          `INSERT INTO social_accounts (id, brand_id, network, external_id, name, username, avatar, page_id, token, status, verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
           ON CONFLICT(brand_id, network, external_id) DO UPDATE SET token = excluded.token, name = excluded.name, username = excluded.username, avatar = excluded.avatar, status = 'connected', verified_at = excluded.verified_at, error = NULL`,
        ).run(uid('sa_'), p.brandId, network, externalId, name, username, avatar, c.pageId, seal(c.pageToken), now(), now());
        linked++;
      };
      if (s.facebook) await add('facebook', c.pageId, c.pageName, null, c.pagePicture);
      if (s.instagram && c.ig) await add('instagram', c.ig.id, c.ig.username, c.ig.username, c.ig.picture);
    }
    // Token do usuário (60 dias): usado para ler contas de anúncio e resultados de tráfego pago.
    if (p.userToken) {
      setSetting('meta.userToken', seal(p.userToken));
      setSetting('meta.userTokenExp', p.expiresIn ? new Date(Date.now() + p.expiresIn * 1000).toISOString() : null);
    }
    pending.delete(state);
    return { linked };
  });

  app.post('/api/social/accounts/:id/verify', async (req) => {
    const a = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get((req.params as any).id) as any;
    if (!a) throw notFound('Perfil');
    if (a.network === 'tiktok') return rowToAccount(a);
    try {
      await verifyAccount(a.network, a.external_id, unseal(a.token));
      db.prepare("UPDATE social_accounts SET status = 'connected', verified_at = ?, error = NULL WHERE id = ?").run(now(), a.id);
    } catch (e) {
      db.prepare("UPDATE social_accounts SET status = 'error', error = ? WHERE id = ?").run((e as Error).message, a.id);
    }
    return rowToAccount(db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(a.id));
  });

  app.post('/api/social/tiktok/assisted', async (req) => {
    const { brandId, username } = (req.body ?? {}) as { brandId: string; username: string };
    const u = String(username ?? '').replace(/^@/, '').trim();
    if (!u) throw badRequest('Informe o @ do perfil no TikTok.');
    db.prepare("INSERT OR IGNORE INTO social_accounts (id, brand_id, network, external_id, name, username, status, created_at) VALUES (?, ?, 'tiktok', ?, ?, ?, 'assisted', ?)").run(uid('sa_'), brandId, u, '@' + u, u, now());
    return { ok: true };
  });

  app.delete('/api/social/accounts/:id', async (req) => {
    db.prepare('DELETE FROM social_accounts WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });

  // Mídias publicáveis: vídeos exportados + imagens/vídeos da biblioteca.
  app.get('/api/social/meta-health', async () =>
    recheckBlock(async () => {
      const a = db.prepare("SELECT * FROM social_accounts WHERE token IS NOT NULL AND status = 'connected' AND network IN ('instagram','facebook') LIMIT 1").get() as any;
      if (a) await metaFetch(`https://graph.facebook.com/${graphVersion()}/${a.external_id}?fields=id&access_token=${unseal(a.token)}`);
    }),
  );

  app.get('/api/social/media', async (req) => {
    const { brandId } = req.query as { brandId: string };
    const exports = (db.prepare('SELECT e.*, p.name AS project_name FROM exports e JOIN projects p ON p.id = e.project_id WHERE e.brand_id = ? ORDER BY e.created_at DESC').all(brandId) as any[])
      .filter((e) => fs.existsSync(exportPath(e.brand_id, e.file)))
      .map((e) => ({ source: 'export', id: e.id, kind: 'video', name: e.project_name, projectId: e.project_id, settings: JSON.parse(e.settings), createdAt: e.created_at, url: `/api/exports/${e.id}/file` }));
    const assets = (db.prepare("SELECT * FROM assets WHERE brand_id = ? AND kind IN ('image','video') AND status = 'ready' ORDER BY created_at DESC").all(brandId) as any[]).map((a) => {
      const meta = JSON.parse(a.meta);
      return { source: 'asset', id: a.id, kind: a.kind, name: a.name, settings: { width: meta.width, height: meta.height }, createdAt: a.created_at, url: a.kind === 'image' ? `/api/assets/${a.id}/media/original` : `/api/assets/${a.id}/media/proxy` };
    });
    return [...exports, ...assets];
  });

  // ---- posts ----
  app.get('/api/posts', async (req) => {
    const qy = req.query as { brandId?: string; from?: string; to?: string };
    const where: string[] = [];
    const args: any[] = [];
    if (qy.brandId) (where.push('brand_id = ?'), args.push(qy.brandId));
    if (qy.from) (where.push('(scheduled_at IS NULL OR scheduled_at >= ?)'), args.push(qy.from));
    if (qy.to) (where.push('(scheduled_at IS NULL OR scheduled_at < ?)'), args.push(qy.to));
    return db.prepare(`SELECT * FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(scheduled_at, created_at)`).all(...args).map(rowToPost);
  });

  app.get('/api/posts/:id', async (req) => {
    const r = db.prepare('SELECT * FROM posts WHERE id = ?').get((req.params as any).id);
    if (!r) throw notFound('Post');
    return rowToPost(r);
  });

  app.post('/api/posts', async (req) => {
    const b = (req.body ?? {}) as any;
    if (!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(b.brandId)) throw badRequest('Escolha a marca.');
    validatePost({ type: b.type, media: b.media ?? [], targets: b.targets ?? [] }, b.brandId);
    const id = uid('po_');
    db.prepare('INSERT INTO posts (id, brand_id, project_id, type, media, caption, captions, status, scheduled_at, timezone, cover, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, b.brandId, b.projectId ?? null, b.type, JSON.stringify(b.media), String(b.caption ?? '').slice(0, 5000), JSON.stringify(b.captions ?? {}), 'draft', b.scheduledAt ?? null, b.timezone ?? 'America/Sao_Paulo', cleanCover(b.cover, b.brandId, b.type), now(), now(),
    );
    setTargets(id, b.targets ?? []);
    return rowToPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  });

  app.put('/api/posts/:id', async (req) => {
    const id = (req.params as any).id;
    const r = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
    if (!r) throw notFound('Post');
    if (!EDITABLE.includes(r.status)) throw new AppError(409, 'Este post não pode ser editado agora.', r.status === 'scheduled' ? 'Cancele o agendamento para editar.' : 'Ele já foi publicado ou está publicando.');
    const b = (req.body ?? {}) as any;
    validatePost({ type: b.type, media: b.media ?? [], targets: b.targets ?? [] }, r.brand_id);
    db.prepare('UPDATE posts SET type = ?, media = ?, caption = ?, captions = ?, scheduled_at = ?, timezone = ?, cover = ?, status = ?, updated_at = ? WHERE id = ?').run(
      b.type, JSON.stringify(b.media), String(b.caption ?? '').slice(0, 5000), JSON.stringify(b.captions ?? {}), b.scheduledAt ?? null, b.timezone ?? r.timezone, cleanCover(b.cover, r.brand_id, b.type), r.status === 'approved' || r.status === 'failed' ? 'review' : r.status, now(), id,
    );
    setTargets(id, b.targets ?? []);
    return rowToPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  });

  app.post('/api/posts/:id/action', async (req) => {
    const id = (req.params as any).id;
    const r = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
    if (!r) throw notFound('Post');
    const { action, scheduledAt } = (req.body ?? {}) as { action: string; scheduledAt?: string };
    const targets = db.prepare('SELECT COUNT(*) AS n FROM post_targets WHERE post_id = ?').get(id) as any;
    const set = (status: string, extra = '') => db.prepare(`UPDATE posts SET status = ?, updated_at = ?${extra} WHERE id = ?`).run(status, now(), id);
    switch (action) {
      case 'review':
        if (!['draft', 'failed'].includes(r.status)) throw badRequest('Só rascunhos vão para revisão.');
        set('review');
        break;
      case 'approve':
        if (!['draft', 'review'].includes(r.status)) throw badRequest('Este post não está aguardando aprovação.');
        set('approved');
        break;
      case 'back_to_draft':
        if (!EDITABLE.includes(r.status)) throw badRequest('Não é possível voltar para rascunho agora.');
        set('draft');
        break;
      case 'schedule': {
        if (!['approved', 'failed'].includes(r.status)) throw badRequest('Aprove o post antes de agendar.', 'Fluxo: Rascunho → Revisão → Aprovado → Agendado.');
        if (!targets.n) throw badRequest('Escolha ao menos um perfil de destino.');
        const when = Date.parse(String(scheduledAt));
        if (!isFinite(when) || when < Date.now() + 60_000) throw badRequest('Escolha um horário pelo menos 1 minuto no futuro.');
        db.prepare("UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ? AND status != 'published'").run(id);
        db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?").run(new Date(when).toISOString(), now(), id);
        break;
      }
      case 'unschedule':
        if (r.status !== 'scheduled') throw badRequest('Este post não está agendado.');
        set('approved');
        break;
      case 'publish_now': {
        if (!['approved', 'failed', 'scheduled'].includes(r.status)) throw badRequest('Aprove o post antes de publicar.');
        if (!targets.n) throw badRequest('Escolha ao menos um perfil de destino.');
        const running = db.prepare("SELECT 1 FROM jobs WHERE type = 'publish' AND status IN ('queued','running') AND payload LIKE ?").get(`%${id}%`);
        if (running) throw new AppError(409, 'Este post já está sendo publicado.', 'Aguarde terminar.');
        db.prepare("UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ? AND status = 'failed'").run(id);
        set('publishing');
        enqueue({ type: 'publish', title: 'Publicando post', brandId: r.brand_id, payload: { postId: id } });
        break;
      }
      default:
        throw badRequest('Ação desconhecida.');
    }
    return rowToPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  });

  // Publicação assistida (TikTok): você publica no app e confirma aqui com o link.
  app.post('/api/posts/:id/targets/:tid/manual', async (req) => {
    const { id, tid } = req.params as any;
    const { permalink } = (req.body ?? {}) as { permalink?: string };
    if (!permalink || !/^https:\/\/(www\.|vm\.)?tiktok\.com\//.test(permalink)) throw badRequest('Cole o link do vídeo publicado no TikTok.', 'Ex.: https://www.tiktok.com/@perfil/video/123…');
    db.prepare("UPDATE post_targets SET status = 'published', permalink = ?, published_at = ?, error = NULL WHERE id = ? AND post_id = ?").run(permalink, now(), tid, id);
    const all = db.prepare('SELECT status FROM post_targets WHERE post_id = ?').all(id) as any[];
    if (all.every((x) => x.status === 'published')) db.prepare("UPDATE posts SET status = 'published', updated_at = ? WHERE id = ?").run(now(), id);
    return rowToPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  });

  app.delete('/api/posts/:id', async (req) => {
    const r = db.prepare('SELECT status FROM posts WHERE id = ?').get((req.params as any).id) as any;
    if (r && ['publishing', 'published'].includes(r.status)) throw badRequest('Posts publicados ficam no histórico.');
    db.prepare('DELETE FROM posts WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });
}
