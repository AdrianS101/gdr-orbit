import type { FastifyInstance } from 'fastify';
import { db, getSetting, now, setSetting } from '../db.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { uid } from '../../../shared/timeline.ts';
import { commentTriggers, dmText, followUpReply, pickCommentReply, EMPTY_AUTOMATION, type AutomationConfig } from '../../../shared/automation.ts';
import { pollInbox, replyComment, sendDm, suggestReply } from './inbox.ts';
import { MetaError } from './meta.ts';
import { AiError } from '../ai/providers.ts';

const asApp = (e: unknown) => (e instanceof MetaError ? new AppError(400, e.message, e.hint) : e instanceof AiError ? new AppError(503, e.message, e.hint) : e);

function rowToContact(r: any) {
  const last = db.prepare('SELECT text, kind, direction, created_at FROM messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1').get(r.id) as any;
  return { id: r.id, brandId: r.brand_id, accountId: r.account_id, network: r.network, username: r.username, name: r.name, tags: JSON.parse(r.tags).filter((t: string) => !t.startsWith('aguarda:')), status: r.status, paused: !!r.paused, unread: r.unread, lastMessageAt: r.last_message_at, lastInboundAt: r.last_inbound_at, last };
}

function cleanConfig(c: any): AutomationConfig {
  const cfg = { ...EMPTY_AUTOMATION, ...(c ?? {}) } as AutomationConfig;
  cfg.keywords = (cfg.keywords ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
  if (!cfg.keywords.length) throw badRequest('Informe ao menos uma palavra-chave.', 'Ex.: GUIA');
  if (!String(cfg.dm ?? '').trim()) throw badRequest('Escreva a mensagem que será enviada no direct.');
  cfg.commentReplies = (cfg.commentReplies ?? []).map(String).filter((x) => x.trim()).slice(0, 10);
  if (cfg.mediaIds !== 'all' && (!Array.isArray(cfg.mediaIds) || !cfg.mediaIds.length)) cfg.mediaIds = 'all';
  return cfg;
}

export async function inboxRoutes(app: FastifyInstance) {
  // ---- caixa de entrada ----
  app.get('/api/inbox/contacts', async (req) => {
    const q = req.query as { brandId?: string; status?: string; network?: string; q?: string; kind?: string };
    const where = ['1=1'];
    const args: any[] = [];
    // Tipo: conversas que têm Direct ou que têm comentários.
    if (q.kind === 'dm') where.push("EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = contacts.id AND m.kind IN ('dm','private_reply'))");
    if (q.kind === 'comment') where.push("EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = contacts.id AND m.kind IN ('comment','comment_reply'))");
    if (q.brandId) (where.push('brand_id = ?'), args.push(q.brandId));
    if (q.status) (where.push('status = ?'), args.push(q.status));
    if (q.network) (where.push('network = ?'), args.push(q.network));
    if (q.q) (where.push('(username LIKE ? OR name LIKE ? OR tags LIKE ?)'), args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`));
    return (db.prepare(`SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY last_message_at DESC LIMIT 300`).all(...args) as any[]).map(rowToContact);
  });

  app.get('/api/inbox/contacts/:id/messages', async (req) => {
    const id = (req.params as any).id;
    db.prepare('UPDATE contacts SET unread = 0 WHERE id = ?').run(id);
    return (db.prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at').all(id) as any[]).map((m) => ({ id: m.id, externalId: m.external_id, direction: m.direction, kind: m.kind, text: m.text, context: JSON.parse(m.context), status: m.status, author: m.author, error: m.error, createdAt: m.created_at }));
  });

  app.patch('/api/inbox/contacts/:id', async (req) => {
    const id = (req.params as any).id;
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as any;
    if (!c) throw notFound('Contato');
    const b = (req.body ?? {}) as { status?: string; tags?: string[]; paused?: boolean };
    if (b.status && ['open', 'pending', 'done'].includes(b.status)) db.prepare('UPDATE contacts SET status = ? WHERE id = ?').run(b.status, id);
    if (Array.isArray(b.tags)) {
      const keep = JSON.parse(c.tags).filter((t: string) => t.startsWith('aguarda:'));
      db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify([...keep, ...b.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)]), id);
    }
    if (b.paused !== undefined) db.prepare('UPDATE contacts SET paused = ? WHERE id = ?').run(b.paused ? 1 : 0, id);
    return rowToContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
  });

  app.post('/api/inbox/contacts/:id/send', async (req) => {
    const id = (req.params as any).id;
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as any;
    if (!c) throw notFound('Contato');
    const acc = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(c.account_id) as any;
    const { text, commentId, suggestionId } = (req.body ?? {}) as { text?: string; commentId?: string; suggestionId?: string };
    if (!text?.trim()) throw badRequest('Escreva a mensagem.');
    try {
      if (commentId) await replyComment(acc, c, commentId, text.trim(), 'human');
      else await sendDm(acc, c, text.trim(), 'human');
      if (suggestionId) db.prepare("UPDATE messages SET status = 'used' WHERE id = ? AND status = 'suggested'").run(suggestionId);
    } catch (e) {
      throw asApp(e);
    }
    return { ok: true };
  });

  app.post('/api/inbox/contacts/:id/suggest', async (req) => {
    const id = (req.params as any).id;
    try {
      const s = await suggestReply(id);
      const mid = uid('m_');
      db.prepare("INSERT INTO messages (id, contact_id, direction, kind, text, context, status, author, created_at) VALUES (?, ?, 'out', 'dm', ?, ?, 'suggested', 'ai', ?)").run(mid, id, s.reply, JSON.stringify({ reason: s.reason, needsHuman: s.needsHuman, model: s.model }), now());
      return { id: mid, ...s };
    } catch (e) {
      throw asApp(e);
    }
  });

  app.post('/api/inbox/poll', async () => {
    await pollInbox();
    return { ok: true };
  });

  app.get('/api/inbox/mode', async (req) => ({ mode: getSetting(`inbox.mode.${(req.query as any).accountId}`, 'manual') }));
  app.put('/api/inbox/mode', async (req) => {
    const { accountId, mode } = (req.body ?? {}) as { accountId: string; mode: string };
    if (!['manual', 'auto'].includes(mode)) throw badRequest('Modo inválido.');
    setSetting(`inbox.mode.${accountId}`, mode);
    return { ok: true };
  });

  // ---- automações ----
  const rowToAuto = (a: any) => {
    const stats = db.prepare("SELECT SUM(step = 'dm' AND status = 'done') AS sent, SUM(step = 'trigger') AS triggered, SUM(status = 'failed') AS failed FROM automation_runs WHERE automation_id = ?").get(a.id) as any;
    return { id: a.id, brandId: a.brand_id, accountId: a.account_id, name: a.name, active: !!a.active, config: JSON.parse(a.config), stats: { triggered: stats.triggered ?? 0, sent: stats.sent ?? 0, failed: stats.failed ?? 0 }, updatedAt: a.updated_at };
  };

  app.get('/api/automations', async (req) => {
    const { brandId } = req.query as { brandId?: string };
    return (brandId ? db.prepare('SELECT * FROM automations WHERE brand_id = ? ORDER BY created_at DESC').all(brandId) : db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all()).map(rowToAuto);
  });

  app.post('/api/automations', async (req) => {
    const b = (req.body ?? {}) as { accountId: string; name?: string; config: any };
    const acc = db.prepare("SELECT * FROM social_accounts WHERE id = ? AND network IN ('instagram','facebook')").get(b.accountId) as any;
    if (!acc) throw badRequest('Escolha um perfil do Instagram ou do Facebook conectado.');
    const id = uid('au_');
    db.prepare('INSERT INTO automations (id, brand_id, account_id, name, active, config, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)').run(id, acc.brand_id, acc.id, String(b.name ?? '').trim() || 'Nova automação', JSON.stringify(cleanConfig(b.config)), now(), now());
    return rowToAuto(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  });

  app.put('/api/automations/:id', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as { name?: string; config: any };
    db.prepare('UPDATE automations SET name = ?, config = ?, updated_at = ? WHERE id = ?').run(String(b.name ?? '').trim() || 'Automação', JSON.stringify(cleanConfig(b.config)), now(), id);
    return rowToAuto(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  });

  app.post('/api/automations/:id/active', async (req) => {
    const id = (req.params as any).id;
    const { active } = (req.body ?? {}) as { active: boolean };
    const a = db.prepare('SELECT a.*, s.error FROM automations a JOIN social_accounts s ON s.id = a.account_id WHERE a.id = ?').get(id) as any;
    if (!a) throw notFound('Automação');
    if (active && a.error && /mensagens/.test(a.error)) throw new AppError(400, 'Este perfil ainda não tem permissão de mensagens.', a.error);
    db.prepare('UPDATE automations SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), id);
    return rowToAuto(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  });

  app.delete('/api/automations/:id', async (req) => {
    db.prepare('DELETE FROM automations WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });

  app.get('/api/automations/:id/runs', async (req) => {
    return (db.prepare('SELECT r.*, c.username, c.name FROM automation_runs r LEFT JOIN contacts c ON c.id = r.contact_id WHERE r.automation_id = ? ORDER BY r.created_at DESC LIMIT 200').all((req.params as any).id) as any[]).map((r) => ({ step: r.step, status: r.status, detail: r.detail, contact: r.username ? `@${r.username}` : r.name, createdAt: r.created_at }));
  });

  // Teste simulado: mostra o que aconteceria. Não envia nada.
  app.post('/api/automations/test', async (req) => {
    const { config, comment, reply, name } = (req.body ?? {}) as { config: any; comment: string; reply?: string; name?: string };
    const cfg = cleanConfig(config);
    const vars = { nome: name || 'Maria Silva', usuario: 'maria.silva' };
    const hit = commentTriggers({ ...cfg, mediaIds: 'all' }, comment ?? '', '');
    if (!hit) return { triggered: false, steps: [`O comentário "${comment}" não contém nenhuma palavra-chave (${cfg.keywords.join(', ')}). Nada seria enviado.`] };
    const steps = [`Dispara pela palavra-chave "${hit}".`];
    const pub = pickCommentReply(cfg, 0, vars);
    if (pub) steps.push(`Resposta pública no comentário: "${pub}"`);
    steps.push(`DM privada: "${dmText(cfg, vars)}"`);
    if (reply) {
      const f = followUpReply(cfg, reply);
      steps.push(f ? `Quando a pessoa responder "${reply}", envia: "${f.reply}"` : `A resposta "${reply}" não corresponde a nenhuma opção da continuidade.`);
    }
    return { triggered: true, steps };
  });

  app.get('/api/automations/media', async (req) => {
    const { accountId } = req.query as { accountId: string };
    return (db.prepare('SELECT external_id, caption, thumb, posted_at, type FROM media_items WHERE account_id = ? ORDER BY posted_at DESC LIMIT 40').all(accountId) as any[]).map((m) => ({ id: m.external_id, caption: m.caption, thumb: m.thumb, postedAt: m.posted_at, type: m.type }));
  });
}
