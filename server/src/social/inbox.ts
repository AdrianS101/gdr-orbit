// Caixa de entrada e automações (Instagram/Facebook via API oficial da Meta).
// Busca novidades a cada minuto enquanto o GDR Digital está aberto. Registra tudo o que foi
// recebido, sugerido e enviado. Nunca envia fora das regras da Meta (24 h para DM; 7 dias para resposta privada).
import { db, getSetting, now, setSetting } from '../db.ts';
import { unseal } from '../lib/vault.ts';
import { uid } from '../../../shared/timeline.ts';
import { commentTriggers, deliveryMessage, fill, linkMessage, describeOut, dmText, followUpReply, gateMessage, isButtonReply, nextAfterClick, openingMessage, pickCommentReply, privateReplyAllowed, usesButtonFlow, withinWindow, type AutomationConfig, type FlowStage, type OutMessage } from '../../../shared/automation.ts';
import { graphVersion, MetaError } from './meta.ts';
import { generateJson } from '../ai/providers.ts';
import { brandContext } from '../ai/copy.ts';
import { rowToBrand } from '../lib/mappers.ts';
import { backgroundAllowed, isAppBlock, metaFetch, metaHealth } from './meta-guard.ts';
const metaUsage = () => metaHealth().usage;

const G = () => `https://graph.facebook.com/${graphVersion()}`;

async function call(method: 'GET' | 'POST', path: string, params: Record<string, string>, token: string, body?: unknown): Promise<any> {
  const url = `${G()}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  const r = await metaFetch(url, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error ?? {};
    if (isAppBlock(String(e.message ?? ''))) throw new MetaError('A Meta bloqueou temporariamente o app.', 'Confirme a conta em developers.facebook.com. Não precisa reconectar os perfis.');
    if (e.code === 10 || e.code === 200 || e.code === 230) throw new MetaError(`A Meta não liberou mensagens/comentários para esta conexão (${e.message}).`, 'Reconecte o perfil aceitando as permissões de mensagens e comentários e ative "Permitir acesso a mensagens" no app do Instagram.');
    if (e.error_subcode === 2534048) throw new MetaError('O app da Meta ainda não tem acesso avançado de mensagens: só dá para enviar a 1ª resposta ao comentário para quem não tem função no app.', 'Para conversar no Direct com qualquer pessoa, o app precisa passar pela análise da Meta (instagram_manage_messages). Enquanto isso, a automação manda o link já na 1ª mensagem.');
    if (e.error_subcode === 2534022) throw new MetaError('A Meta não abriu a conversa para esta pessoa (fora da janela de 24 h).', 'A pessoa precisa mandar uma mensagem (ou tocar numa resposta rápida) antes de receber a próxima.');
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

/** Texto simples ou modelo com botões (button template da Meta). */
/**
 * Texto, "respostas rápidas" ou modelo com botão de link.
 * Botões de continuar (postback) vão como respostas rápidas: o toque vira uma mensagem de verdade da pessoa,
 * que abre a janela de 24 h da Meta (o toque em botão postback dentro do balão não abre — erro #10 2534022).
 */
function toGraph(m: OutMessage) {
  const links = (m.buttons ?? []).filter((b) => b.type === 'web_url');
  const quick = (m.buttons ?? []).filter((b) => b.type === 'postback');
  const msg: any = links.length
    ? { attachment: { type: 'template', payload: { template_type: 'button', text: m.text.slice(0, 640), buttons: links.slice(0, 3) } } }
    : { text: m.text.slice(0, 1000) };
  if (quick.length) msg.quick_replies = quick.slice(0, 13).map((b: any) => ({ content_type: 'text', title: b.title.slice(0, 20), payload: b.payload }));
  return msg;
}

export async function sendDm(acc: any, contact: any, msg: string | OutMessage, author: string): Promise<void> {
  const out: OutMessage = typeof msg === 'string' ? { text: msg } : msg;
  const text = describeOut(out);
  if (!withinWindow(contact.last_inbound_at)) {
    addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: null, text, status: 'failed', author, error: 'Fora da janela de 24 h da Meta: só é possível responder depois que a pessoa mandar uma nova mensagem.' });
    throw new MetaError('Fora da janela de 24 h da Meta.', 'Só é possível responder depois que a pessoa mandar uma nova mensagem.');
  }
  const token = unseal(acc.token);
  try {
    const r = await call('POST', `${acc.page_id}/messages`, {}, token, { recipient: { id: contact.external_id }, message: toGraph(out), messaging_type: 'RESPONSE' });
    addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: r.message_id ?? null, text, status: 'sent', author });
  } catch (e) {
    addMessage(contact.id, { direction: 'out', kind: 'dm', externalId: null, text, status: 'failed', author, error: (e as Error).message });
    throw e;
  }
}

/** Resposta privada ao comentário. Devolve o id da pessoa no Direct (recipient_id), usado para continuar o fluxo. */
async function privateReply(acc: any, contact: any, commentId: string, msg: string | OutMessage, author: string): Promise<string | null> {
  let out: OutMessage = typeof msg === 'string' ? { text: msg } : msg;
  let r: any;
  try {
    r = await call('POST', `${acc.page_id}/messages`, {}, unseal(acc.token), { recipient: { comment_id: commentId }, message: toGraph(out) });
  } catch (e) {
    // Se a Meta recusar o botão nesta resposta, manda em texto pedindo para responder com o título do botão (o fluxo reconhece igual).
    const btn = out.buttons?.find((b) => b.type === 'postback');
    if (!btn || /janela|não liberou/.test((e as Error).message)) throw e;
    out = { text: `${out.text}\n\nResponda "${btn.title}" para receber.` };
    r = await call('POST', `${acc.page_id}/messages`, {}, unseal(acc.token), { recipient: { comment_id: commentId }, message: toGraph(out) });
  }
  addMessage(contact.id, { direction: 'out', kind: 'private_reply', externalId: r.message_id ?? null, text: describeOut(out), context: { commentId, recipientId: r.recipient_id ?? null }, status: 'sent', author });
  return r.recipient_id ?? null;
}

/** Perfil cujo app ainda não tem acesso avançado de mensagens (detectado por erro real da Meta). */
const dmLimited = (acc: any) => getSetting<boolean>(`meta.dmLimited.${acc.id}`, false);
function markDmLimited(acc: any) {
  setSetting(`meta.dmLimited.${acc.id}`, true);
}

/** A pessoa segue o perfil? (API de perfil do Instagram para quem conversa com a conta). null = não foi possível verificar. */
async function checkFollows(acc: any, recipientId: string): Promise<boolean | null> {
  if (acc.network !== 'instagram') return null;
  try {
    const r = await call('GET', recipientId, { fields: 'is_user_follow_business' }, unseal(acc.token));
    return typeof r.is_user_follow_business === 'boolean' ? r.is_user_follow_business : null;
  } catch (e) {
    console.warn('[automação] não foi possível verificar se segue:', (e as Error).message);
    return null;
  }
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
    // Só conta como "já recebeu" quando o conteúdo (link) foi entregue — um convite com botão que ficou sem resposta não conta.
    const already =
      db.prepare("SELECT 1 FROM automation_flows WHERE automation_id = ? AND contact_id = ? AND stage = 'delivered'").get(a.id, contact.id) ||
      db.prepare("SELECT 1 FROM automation_runs WHERE automation_id = ? AND contact_id = ? AND step = 'dm' AND status = 'done' AND (detail IS NULL OR detail NOT LIKE 'Convite%')").get(a.id, contact.id);
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
      if (usesButtonFlow(cfg) && dmLimited(acc)) {
        // App sem "acesso avançado" de mensagens: a Meta só deixa enviar a 1ª mensagem (resposta ao comentário).
        // Então o link vai já nela, como botão — funciona para qualquer pessoa.
        await privateReply(acc, contact, c.id, linkMessage(cfg, vars), 'automation');
        finishRun(a.id, c.id, 'dm', 'done', 'Link enviado direto na 1ª mensagem (app sem acesso avançado de mensagens da Meta).');
      } else if (usesButtonFlow(cfg)) {
        // Fluxo com botão: a 1ª mensagem só convida; o conteúdo vai depois do clique (e de seguir, se exigido).
        const flowId = uid('fl_');
        const recipient = await privateReply(acc, contact, c.id, openingMessage(cfg, vars, flowId), 'automation');
        if (recipient) {
          db.prepare("INSERT INTO automation_flows (id, automation_id, account_id, recipient_id, contact_id, comment_id, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'opened', ?, ?) ON CONFLICT(automation_id, recipient_id) DO UPDATE SET stage = 'opened', checks = 0, comment_id = excluded.comment_id, updated_at = excluded.updated_at").run(flowId, a.id, acc.id, recipient, contact.id, c.id, now(), now());
          finishRun(a.id, c.id, 'dm', 'done', 'Convite com botão enviado; aguardando o clique.');
        } else finishRun(a.id, c.id, 'dm', 'done', 'Convite enviado, mas a Meta não informou o destinatário: o clique não poderá ser acompanhado.');
      } else {
        await privateReply(acc, contact, c.id, linkMessage(cfg, vars), 'automation');
        finishRun(a.id, c.id, 'dm', 'done', null);
      }
      finishRun(a.id, c.id, 'trigger', 'done', null);
      if (cfg.followUp?.options.length) db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify(Array.from(new Set([...JSON.parse(contact.tags), `aguarda:${a.id}`]))), contact.id);
    } catch (e) {
      finishRun(a.id, c.id, 'dm', 'failed', (e as Error).message);
      finishRun(a.id, c.id, 'trigger', 'failed', (e as Error).message);
    }
  }
}

/** Clique nos botões do fluxo (chega no Direct como mensagem com o título do botão). Devolve true se tratou. */
async function onFlowMessage(acc: any, contact: any, msgId: string, text: string): Promise<boolean> {
  const flows = db.prepare("SELECT f.*, a.config FROM automation_flows f JOIN automations a ON a.id = f.automation_id WHERE f.account_id = ? AND f.recipient_id = ? AND f.stage != 'delivered' AND a.active = 1").all(acc.id, contact.external_id) as any[];
  for (const fl of flows) {
    const cfg = JSON.parse(fl.config) as AutomationConfig;
    const stage = fl.stage as FlowStage;
    if (!isButtonReply(cfg, stage, text)) continue;
    if (!runOnce(fl.automation_id, msgId, `click_${stage}`, contact.id)) return true;
    const vars = { nome: contact.name, usuario: contact.username };
    const follows = cfg.followGate?.enabled ? await checkFollows(acc, fl.recipient_id) : null;
    const next = nextAfterClick(cfg, stage, follows, fl.checks);
    const live = { ...contact, last_inbound_at: now() };
    try {
      if (next.send === 'delivery') await sendDm(acc, live, deliveryMessage(cfg, vars), 'automation');
      else if (next.send === 'gate' || next.send === 'gate_retry') await sendDm(acc, live, gateMessage(cfg, fl.id, next.send === 'gate_retry'), 'automation');
      db.prepare('UPDATE automation_flows SET stage = ?, checks = checks + ?, updated_at = ? WHERE id = ?').run(next.stage, cfg.followGate?.enabled ? 1 : 0, now(), fl.id);
      const why = next.send === 'delivery' ? (cfg.followGate?.enabled ? 'Segue o perfil: conteúdo entregue.' : 'Clicou: conteúdo entregue.') : next.send === 'none' ? 'Limite de verificações atingido.' : follows === null ? 'Não foi possível confirmar se segue: pediu para seguir.' : 'Ainda não segue: pediu para seguir.';
      finishRun(fl.automation_id, msgId, `click_${stage}`, 'done', why);
    } catch (e) {
      if (/acesso avançado|janela de 24 h/i.test((e as Error).message)) markDmLimited(acc);
      finishRun(fl.automation_id, msgId, `click_${stage}`, 'failed', (e as Error).message);
    }
    return true;
  }
  return false;
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

async function pollAccount(acc: any, fast = false) {
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
        if (!(await onFlowMessage(acc, fresh, m.id, m.message ?? '')) && !(await onFollowUp(acc, fresh, m.id, m.message ?? ''))) await autoReply(acc, fresh);
      }
    }
  }
  // Comentários nas publicações recentes
  let media: any[] = [];
  try {
    media =
      acc.network === 'instagram'
        ? (await call('GET', `${acc.external_id}/media`, { fields: 'id,timestamp,comments_count', limit: '12' }, token)).data ?? []
        : (await call('GET', `${acc.external_id}/published_posts`, { fields: 'id,created_time,comments.summary(true).limit(0)', limit: '12' }, token)).data ?? [];
  } catch (e) {
    errors.push(`Comentários: ${(e as Error).message}`);
  }
  // Só busca os comentários dos posts cujo total de comentários mudou desde a última verificação.
  const seen = getSetting<Record<string, number>>(`inbox.cc.${acc.id}`, {});
  const nextSeen: Record<string, number> = {};
  for (const md of media) {
    const count = Number(md.comments_count ?? md.comments?.summary?.total_count ?? -1);
    nextSeen[md.id] = count;
    if (count >= 0 && seen[md.id] === count) continue;
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
  setSetting(`inbox.cc.${acc.id}`, nextSeen);
  if (!fast) await enrichContacts(acc, token).catch(() => {});
  setSetting(`inbox.since.${acc.id}`, started);
  db.prepare('UPDATE social_accounts SET error = NULL WHERE id = ? AND error LIKE ?').run(acc.id, '%mensagens%');
  if (errors.length) console.warn(`[caixa de entrada] ${acc.username ?? acc.name}:`, errors.join(' | '));
}

/** Nome e foto de quem conversa com a conta (API de perfil do Instagram). Poucos por rodada; tenta de novo só após 7 dias. */
async function enrichContacts(acc: any, token: string) {
  if (acc.network !== 'instagram') return;
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const list = db.prepare("SELECT id, external_id FROM contacts WHERE account_id = ? AND (avatar IS NULL OR name IS NULL) AND external_id NOT LIKE 'user:%' AND (profile_checked_at IS NULL OR profile_checked_at < ?) ORDER BY last_message_at DESC LIMIT 3").all(acc.id, week) as any[];
  for (const c of list) {
    const r = await call('GET', c.external_id, { fields: 'name,username,profile_pic' }, token).catch(() => null);
    db.prepare('UPDATE contacts SET name = COALESCE(?, name), username = COALESCE(?, username), avatar = COALESCE(?, avatar), profile_checked_at = ? WHERE id = ?').run(r?.name ?? null, r?.username ?? null, r?.profile_pic ?? null, now(), c.id);
  }
}

let polling = false;
/** Perfis que precisam responder rápido: automação ativa ou caixa de entrada no modo automático. */
function needsFast(acc: any): boolean {
  return !!db.prepare('SELECT 1 FROM automations WHERE account_id = ? AND active = 1').get(acc.id) || getSetting<string>(`inbox.mode.${acc.id}`, 'manual') === 'auto';
}

export async function pollInbox(fast = false) {
  if (polling || !backgroundAllowed()) return;
  polling = true;
  try {
    const accs = (db.prepare("SELECT * FROM social_accounts WHERE network IN ('instagram','facebook') AND token IS NOT NULL AND status = 'connected'").all() as any[]).filter((a) => !fast || needsFast(a));
    for (const a of accs) {
      try {
        await pollAccount(a, fast);
      } catch (e) {
        if (e instanceof MetaError && /não liberou/.test(e.message)) db.prepare('UPDATE social_accounts SET error = ? WHERE id = ?').run(`${e.message} ${e.hint}`, a.id);
      }
    }
  } finally {
    polling = false;
  }
}

export function startInbox() {
  // Erros de bloqueio do app não são problema de permissão do perfil: não pedem reconexão.
  db.prepare("UPDATE social_accounts SET error = NULL WHERE error LIKE '%Cannot call API for app%' OR error LIKE '%API access blocked%'").run();
  // Completo a cada 3 min. Perfis com automação ativa: a cada 20 s (2 chamadas leves; comentários só quando o total muda),
  // desacelerando para 60 s se o medidor de uso da Meta passar de 40%.
  setInterval(() => pollInbox().catch(() => {}), 180_000).unref();
  let last = 0;
  setInterval(() => {
    const gap = metaUsage() > 40 ? 60_000 : 20_000;
    if (Date.now() - last < gap) return;
    last = Date.now();
    pollInbox(true).catch(() => {});
  }, 10_000).unref();
  setTimeout(() => pollInbox().catch(() => {}), 15_000).unref();
}
