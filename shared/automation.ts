// Regras das automações de comentário → DM (estilo ManyChat). Puras e testáveis.

export interface AutomationConfig {
  /** Publicações monitoradas (ids do Instagram/Facebook) ou todas. */
  mediaIds: string[] | 'all';
  keywords: string[];
  match: 'contains' | 'exact';
  /** Resposta pública no comentário (opcional). Várias opções evitam respostas repetidas. */
  commentReplies: string[];
  /** Mensagem privada enviada a quem comentou. Aceita {nome}. */
  dm: string;
  link?: { label: string; url: string } | null;
  /** Pergunta de continuidade e respostas por palavra-chave. */
  followUp?: { question: string; options: { keyword: string; reply: string }[] } | null;
}

export const EMPTY_AUTOMATION: AutomationConfig = {
  mediaIds: 'all',
  keywords: [],
  match: 'contains',
  commentReplies: ['Te mandei no direct! 📩'],
  dm: 'Oi, {nome}! Aqui está o material que você pediu:',
  link: null,
  followUp: null,
};

/** Minúsculas, sem acentos e sem pontuação/emojis nas bordas. */
export function normalize(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesKeyword(text: string, keywords: string[], mode: 'contains' | 'exact'): string | null {
  const t = normalize(text);
  if (!t) return null;
  for (const k of keywords) {
    const n = normalize(k);
    if (!n) continue;
    if (mode === 'exact' ? t === n : ` ${t} `.includes(` ${n} `)) return k;
  }
  return null;
}

export function commentTriggers(cfg: AutomationConfig, text: string, mediaId: string): string | null {
  if (cfg.mediaIds !== 'all' && !cfg.mediaIds.includes(mediaId)) return null;
  return matchesKeyword(text, cfg.keywords, cfg.match);
}

export function followUpReply(cfg: AutomationConfig, text: string): { keyword: string; reply: string } | null {
  for (const o of cfg.followUp?.options ?? []) if (matchesKeyword(text, [o.keyword], 'contains')) return o;
  return null;
}

export function fill(template: string, vars: { nome?: string | null; usuario?: string | null }): string {
  const nome = (vars.nome || vars.usuario || '').split(' ')[0] || 'tudo bem';
  return template.replace(/\{nome\}/gi, nome).replace(/\{usuario\}/gi, vars.usuario ? `@${vars.usuario}` : '');
}

/** Texto final da DM (com o link, se houver). */
export function dmText(cfg: AutomationConfig, vars: { nome?: string | null; usuario?: string | null }): string {
  let t = fill(cfg.dm, vars);
  if (cfg.link?.url) t += `\n\n${cfg.link.label ? cfg.link.label + ': ' : ''}${cfg.link.url}`;
  if (cfg.followUp?.question) t += `\n\n${fill(cfg.followUp.question, vars)}`;
  return t;
}

/** Escolhe uma resposta pública diferente da última usada (evita repetição idêntica). */
export function pickCommentReply(cfg: AutomationConfig, seed: number, vars: { nome?: string | null; usuario?: string | null }): string | null {
  const list = cfg.commentReplies.filter((r) => r.trim());
  if (!list.length) return null;
  return fill(list[seed % list.length], vars);
}

/** A Meta só permite mensagem comum até 24 h depois da última mensagem da pessoa. */
export function withinWindow(lastInboundAt: string | null, now = Date.now()): boolean {
  return !!lastInboundAt && now - Date.parse(lastInboundAt) < 24 * 3600_000;
}

/** Resposta privada a um comentário: permitida até 7 dias depois do comentário. */
export function privateReplyAllowed(commentAt: string, now = Date.now()): boolean {
  return now - Date.parse(commentAt) < 7 * 24 * 3600_000;
}
