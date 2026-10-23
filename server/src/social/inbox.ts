// Caixa de entrada e automações (Instagram/Facebook via API oficial da Meta).
// Busca novidades a cada minuto enquanto o GDR Orbit está aberto. Registra tudo o que foi
// recebido, sugerido e enviado. Nunca envia fora das regras da Meta (24 h para DM; 7 dias para resposta privada).
import { db, getSetting, now, setSetting } from '../db.ts';
import { unseal } from '../lib/vault.ts';
import { uid } from '../../../shared/timeline.ts';
import { commentTriggers, dmText, followUpReply, pickCommentReply, privateReplyAllowed, withinWindow, type AutomationConfig } from '../../../shared/automation.ts';
import { graphVersion, MetaError } from './meta.ts';
import { generateJson } from '../ai/providers.ts';
import { brandContext } from '../ai/copy.ts';
import { rowToBrand } from '../lib/mappers.ts';

const G = () => `https://graph.facebook.com/${graphVersion()}`;

async function call(method: 'GET' | 'POST', path: string, params: Record<string, string>, token: string, body?: unknown): Promise<any> {
  const url = `${G()}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  const r = await fetch(url, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error ?? {};
    if (e.code === 10 || e.code === 200 || e.code === 230) throw new MetaError(`A Meta não liberou mensagens/comentários para esta conexão (${e.message}).`, 'Reconecte o perfil aceitando as permissões de mensagens e comentários e ative "Permitir acesso a mensagens" no app do Instagram.');
    if (e.code === 551 || e.error_subcode === 2018278) throw new MetaError('A pessoa não pode receber esta mensagem agora (fora da janela permitida pela Meta).', 'Responda quando ela mandar uma nova mensagem.');
    throw new MetaError(String(e.message ?? `HTTP ${r.status}`));
  }
  return j;
}

// ---------- contatos e mensagens ----------

function upsertContact(acc: any, extId: string, info: { username?: string | null; name?: string | null; conversationId?: string | null }) {
  db.prepare(
    `INSERT INTO contacts (id, brand_id, account_id, network, external_id, username, name, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, external_id) DO UPDATE SET username = COALESCE(excluded.username, username), name = COALESCE(excluded.name, name), conversation_id = COALESCE(excluded.conversation_id, conversation_id)`,
  ).run(uid('ct_'), acc.brand_id, acc.id, acc.network, extId, info.username ?? null, info.name ?? null, info.conversationId ?? null, now());
  return db.prepare('SELECT * FROM contacts WHERE account_id = ? AND external_id = ?').get(acc.id, extId) as any;
}

/** Insere mensagem; devolve true se era nova (anti-duplicidade pelo id externo). */
function addMessage(contactId: string, m: { direction: 'in' | 'out'; kind: string; externalId: string | null; text: string; context?: any; status: string; author: string; at?: string; error?: string | null }): boolean {
  const r = db
    .prepare('INSERT OR IGNORE INTO messages (id, contact_id, direction, kind, external_id, text, context, status, author, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uid('m_'), contactId, m.direction, m.kind, m.externalId, m.text, JSON.stringify(m.context ?? {}), m.status, m.author, m.error ?? null, m.at ?? now());
  if (!r.changes) return false;
  const at = m.at ?? now();
  if (m.direction === 'in') db.prepare("UPDATE contacts SET last_message_at = MAX(COALESCE(last_message_at,''), ?), last_inbound_at = MAX(COALESCE(last_inbound_at,''), ?), unread = unread + 1, status = CASE WHEN status = 'done' THEN 'open' ELSE status END WHERE id = ?").run(at, at, contactId);
  else db.prepare("UPDATE contacts SET last_message_at = MAX(COALESCE(last_message_at,''), ?) WHERE id = ?").run(at, contactId);
  return true;
}

// ---------- envio ----------

export async function sendDm(acc: any, contact: any, text: string, author: string): Promise<void> {
  if (!withinWindow(contact.last_inbound_at)) {
    addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: null, text, status: 'failed', author, error: 'Fora da janela de 24 h da Meta: só é possível responder depois que a pessoa mandar uma nova mensagem.' });
    throw new MetaError('Fora da janela de 24 h da Meta.', 'Só é possível responder depois que a pessoa mandar uma nova mensagem.');
  }
  const token = unseal(acc.token);
  try {
    const r = await call('POST', `${acc.page_id}/messages`, {}, token, { recipient: { id: contact.external_id }, message: { text }, messaging_type: 'RESPONSE' });
    addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: r.message_id ?? null, text, status: 'sent', author });
  } catch (e) {
    addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: null, text, status: 'failed', author, error: (e as Error).message });
    throw e;
  }
}

async function privateReply(acc: any, contact: any, commentId: string, text: string, author: string) {
  const r = await call('POST', `${acc.page_id}/messages`, {}, unseal(acc.token), { recipient: { comment_id: commentId }, message: { text } });
  addMessage(contact.id, { direction: 'out', kind: 'private_reply', externalId: r.message_id ?? null, text, context: { commentId }, status: 'sent', author });
}

export async function replyComment(acc: any, contact: any, commentId: string, text: string, author: string) {
  const path = acc.network === 'instagram' ? `${commentId}/replies` : `${commentId}/comments`;
  const r = await call('POST', path, { message: text }, unseal(acc.token));
  addMessage(contact.id, { direction: 'out', kind: 'comment_reply', externalId: r.id ?? null, text, context: { commentId }, status: 'sent', author });
}

// ---------- automações ----------

function runOnce(automationId: string, triggerId: string, step: string, contactId: string | null): boolean {
  const r = db.prepare("INSERT OR IGNORE INTO automation_runs (id, automation_id, trigger_id, contact_id, step, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)").run(uid('ar_'), automationId, triggerId, contactId, step, now());
  return r.changes > 0;
}
function finishRun(automationId: string, triggerId: string, step: string, status: string, detail: string | null) {
  db.prepare('UPDATE automation_runs SET status = ?, detail = ? WHERE automation_id = ? AND trigger_id = ? AND step = ?').run(status, detail, automationId, triggerId, step);
}

async function onComment(acc: any, contact: any, c: { id: string; text: string; at: string; mediaId: string }) {
  if (contact.paused) return;
  const autos = db.prepare('SELECT * FROM automations WHERE account_id = ? AND active = 1').all(acc.id) as any[];
  for (const a of autos) {
    const cfg = JSON.parse(a.config) as AutomationConfig;
    if (!commentTriggers(cfg, c.text, c.mediaId)) continue;
    // Anti-duplicidade: cada comentário dispara cada automação no máximo uma vez; e cada pessoa recebe a DM uma vez por automação.
    if (!runOnce(a.id, c.id, 'trigger', contact.id)) continue;
    const already = db.prepare("SELECT 1 FROM automation_runs WHERE automation_id = ? AND contact_id = ? AND step = 'dm' AND status = 'done'").get(a.id, contact.id);
    const vars = { nome: contact.name, usuario: contact.username };
    try {
      const reply = pickCommentReply(cfg, Number.parseInt(c.id.slice(-4), 36) || 0, vars);
      if (reply && runOnce(a.id, c.id, 'comment_reply', contact.id)) {
        await replyComment(acc, contact, c.id, reply, 'automation');
        finishRun(a.id, c.id, 'comment_reply', 'done', null);
      }
      if (already) {
        finishRun(a.id, c.id, 'trigger', 'skipped', 'Esta pessoa já recebeu a DM desta automação.');
        continue;
      }
      if (!privateReplyAllowed(c.at)) {
        finishRun(a.id, c.id, 'trigger', 'skipped', 'Comentário com mais de 7 dias: a Meta não permite resposta privada.');
        continue;
      }
      runOnce(a.id, c.id, 'dm', contact.id);
      await privateReply(acc, contact, c.id, dmText(cfg, vars), 'automation');
      finishRun(a.id, c.id, 'dm', 'done', null);
      finishRun(a.id, c.id, 'trigger', 'done', null);
      if (cfg.followUp?.options.length) db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify(Array.from(new Set([...JSON.parse(contact.tags), `aguarda:${a.id}`]))), contact.id);
    } catch (e) {
      finishRun(a.id, c.id, 'dm', 'failed', (e as Error).message);
      finishRun(a.id, c.id, 'trigger', 'failed', (e as Error).message);
    }
  }
}

/** Resposta da pessoa a uma pergunta de continuidade. Devolve true se uma automação tratou a mensagem. */
async function onFollowUp(acc: any, contact: any, msgId: string, text: string): Promise<boolean> {
  const tags: string[] = JSON.parse(contact.tags);
  for (const t of tags.filter((x) => x.startsWith('aguarda:'))) {
    const a = db.prepare('SELECT * FROM automations WHERE id = ? AND active = 1').get(t.slice(8)) as any;
    if (!a) continue;
    const opt = followUpReply(JSON.parse(a.config), text);
    if (!opt || !runOnce(a.id, msgId, 'followup', contact.id)) continue;
    try {
      await sendDm(acc, { ...contact, last_inbound_at: now() }, opt.reply, 'automation');
      finishRun(a.id, msgId, 'followup', 'done', opt.keyword);
      db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify(tags.filter((x) => x !== t)), contact.id);
      return true;
    } catch (e) {
      finishRun(a.id, msgId, 'followup', 'failed', (e as Error).message);
    }
  }
  return false;
}

// ---------- IA ----------

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'needsHuman', 'reason'],
  properties: {
    reply: { type: 'string' },
    needsHuman: { type: 'boolean', description: 'true se faltar informação confirmada para responder com segurança' },
    reason: { type: 'string' },
  },
};

export async function suggestReply(contactId: string) {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as any;
  const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(c.brand_id));
  const hist = (db.prepare('SELECT direction, kind, text FROM messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 12').all(contactId) as any[]).reverse();
  const ctx = brandContext(brand.name, brand.profile);
  const r = await generateJson<{ reply: string; needsHuman: boolean; reason: string }>({
    system: `Você responde mensagens e comentários em nome da marca, em português do Brasil, de forma humana, curta e cordial.
Regras: use SOMENTE as informações confirmadas do perfil e da base de conhecimento. NUNCA invente preços, condições, prazos, disponibilidade, endereços ou promessas.
Se a pergunta exigir algo que não está na base, responda de forma acolhedora sem inventar e marque needsHuman = true explicando o que falta.`,
    prompt: `${ctx.text}\n\n# Conversa (${c.network}, @${c.username ?? c.name ?? 'contato'})\n${hist.map((h) => `${h.direction === 'in' ? 'Cliente' : 'Marca'} (${h.kind}): ${h.text}`).join('\n')}\n\nEscreva a próxima resposta da marca.`,
    schema: AI_SCHEMA,
    maxTokens: 2000,
  });
  return { ...r.data, model: r.model };
}

async function autoReply(acc: any, contact: any) {
  if (contact.paused || getSetting<string>(`inbox.mode.${acc.id}`, 'manual') !== 'auto') return;
  try {
    const s = await suggestReply(contact.id);
    if (s.needsHuman) {
      addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: null, text: s.reply, status: 'suggested', author: 'ai', context: { reason: s.reason } });
      db.prepare("UPDATE contacts SET status = 'pending' WHERE id = ?").run(contact.id);
    } else await sendDm(acc, contact, s.reply, 'ai');
  } catch {
    db.prepare("UPDATE contacts SET status = 'pending' WHERE id = ?").run(contact.id);
  }
}

// ---------- coleta ----------

/** Conversas em lotes pequenos: a Meta recusa pedidos grandes ("reduce the amount of data"). */
async function fetchConversations(acc: any, token: string) {
  const platform = acc.network === 'instagram' ? 'instagram' : 'messenger';
  try {
    return (await call('GET', `${acc.page_id}/conversations`, { platform, fields: 'id,updated_time,participants,messages.limit(10){id,message,from,created_time}', limit: '10' }, token)).data ?? [];
  } catch (e) {
    if (!(e instanceof MetaError) || !/reduce the amount of data|timeout|time out|unknown error/i.test(e.message)) throw e;
  }
  // Caixas grandes: lista as conversas sem mensagens e busca as mensagens de cada uma separadamente.
  // Páginas de 2 em 2 (a Meta recusa lotes maiores em caixas com muitas mensagens).
  const list: any[] = [];
  let after = '';
  for (let page = 0; page < 5; page++) {
    const r = await call('GET', `${acc.page_id}/conversations`, { platform, fields: 'id,updated_time,participants', limit: '2', ...(after ? { after } : {}) }, token).catch(() => null);
    if (!r) break;
    list.push(...(r.data ?? []));
    after = r.paging?.cursors?.after ?? '';
    if (!after || !r.paging?.next) break;
  }
  for (const cv of list) {
    try {
      cv.messages = await call('GET', `${cv.id}/messages`, { fields: 'id,message,from,created_time', limit: '10' }, token);
    } catch {
      cv.messages = { data: [] };
    }
  }
  return list;
}

async function pollAccount(acc: any) {
  const token = unseal(acc.token);
  // 1ª coleta importa os últimos 30 dias como histórico; automações e IA só agem no que chegar depois dela.
  const since = getSetting<string>(`inbox.since.${acc.id}`, new Date(Date.now() - 30 * 86400_000).toISOString());
  const live = getSetting<string | null>(`inbox.live.${acc.id}`, null) ?? now();
  setSetting(`inbox.live.${acc.id}`, live);
  const started = now();
  const errors: string[] = [];
  // Mensagens diretas
  let conv: any[] = [];
  try {
    conv = await fetchConversations(acc, token);
  } catch (e) {
    if (e instanceof MetaError && /não liberou/.test(e.message)) throw e;
    errors.push(`Directs: ${(e as Error).message}`);
  }
  for (const cv of conv) {
    if (cv.updated_time < since) continue;
    const other = (cv.participants?.data ?? []).find((p: any) => p.id !== acc.external_id && p.id !== acc.page_id);
    if (!other) continue;
    const contact = upsertContact(acc, other.id, { username: other.username ?? null, name: other.name ?? null, conversationId: cv.id });
    for (const m of [...(cv.messages?.data ?? [])].reverse()) {
      const inbound = m.from?.id === other.id;
      const isNew = addMessage(contact.id, { direction: inbound ? 'in' : 'out', kind: 'dm', externalId: m.id, text: m.message ?? '(mídia)', status: inbound ? 'received' : 'sent', author: inbound ? 'contact' : 'human', at: m.created_time });
      if (isNew && inbound && m.created_time >= live) {
        const fresh = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as any;
        if (!(await onFollowUp(acc, fresh, m.id, m.message ?? ''))) await autoReply(acc, fresh);
      }
    }
  }
  // Comentários nas publicações recentes
  let media: any[] = [];
  try {
    media =
      acc.network === 'instagram'
        ? (await call('GET', `${acc.external_id}/media`, { fields: 'id,timestamp', limit: '15' }, token)).data ?? []
        : (await call('GET', `${acc.external_id}/published_posts`, { fields: 'id,created_time', limit: '15' }, token)).data ?? [];
  } catch (e) {
    errors.push(`Comentários: ${(e as Error).message}`);
  }
  for (const md of media) {
    const fields = acc.network === 'instagram' ? 'id,text,timestamp,username,from' : 'id,message,created_time,from';
    const cm = await call('GET', `${md.id}/comments`, { fields, limit: '50' }, token).catch(() => ({ data: [] }));
    for (const c of cm.data ?? []) {
      const at = c.timestamp ?? c.created_time;
      const text = c.text ?? c.message ?? '';
      const fromId = c.from?.id ?? `user:${c.username}`;
      if (fromId === acc.external_id || fromId === acc.page_id) continue;
      const contact = upsertContact(acc, fromId, { username: c.username ?? c.from?.username ?? null, name: c.from?.name ?? null });
      const isNew = addMessage(contact.id, { direction: 'in', kind: 'comment', externalId: c.id, text, context: { mediaId: md.id }, status: 'received', author: 'contact', at });
      if (isNew && at >= live) await onComment(acc, db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id), { id: c.id, text, at, mediaId: md.id });
    }
  }
  setSetting(`inbox.since.${acc.id}`, started);
  db.prepare('UPDATE social_accounts SET error = NULL WHERE id = ? AND error LIKE ?').run(acc.id, '%mensagens%');
  if (errors.length) console.warn(`[caixa de entrada] ${acc.username ?? acc.name}:`, errors.join(' | '));
}

let polling = false;
export async function pollInbox() {
  if (polling) return;
  polling = true;
  try {
    const accs = db.prepare("SELECT * FROM social_accounts WHERE network IN ('instagram','facebook') AND token IS NOT NULL AND status = 'connected'").all() as any[];
    for (const a of accs) {
      try {
        await pollAccount(a);
      } catch (e) {
        if (e instanceof MetaError && /não liberou/.test(e.message)) db.prepare('UPDATE social_accounts SET error = ? WHERE id = ?').run(`${e.message} ${e.hint}`, a.id);
      }
    }
  } finally {
    polling = false;
  }
}

export function startInbox() {
  setInterval(() => pollInbox().catch(() => {}), 60_000).unref();
  setTimeout(() => pollInbox().catch(() => {}), 15_000).unref();
}
