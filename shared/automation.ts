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
  /** Botão na 1ª mensagem (ex.: "Quero o link"). O conteúdo só é entregue depois do clique. */
  button?: { label: string } | null;
  /** Mensagem entregue depois do clique (com o link como botão). Aceita {nome}. */
  delivery?: string;
  /** Só entrega para quem segue o perfil (Instagram). */
  followGate?: { enabled: boolean; message: string; buttonLabel: string; notYet: string } | null;
}

export const EMPTY_AUTOMATION: AutomationConfig = {
  mediaIds: 'all',
  keywords: [],
  match: 'contains',
  commentReplies: ['Te mandei no direct! 📩'],
  dm: 'Oi, {nome}! Aqui está o material que você pediu:',
  link: null,
  followUp: null,
  button: null,
  delivery: 'Aqui está! 👇',
  followGate: null,
};

export const DEFAULT_GATE = { enabled: true, message: 'Perfeito, mas você tem que estar seguindo pra receber...', buttonLabel: 'Estou seguindo', notYet: 'Ainda não encontrei seu follow 👀 Siga o perfil e toque no botão de novo.' };

/** Mensagem com botões (template da Meta). Títulos de botão têm até 20 caracteres. */
export interface OutMessage {
  text: string;
  buttons?: ({ type: 'postback'; title: string; payload: string } | { type: 'web_url'; title: string; url: string })[];
}

export type FlowStage = 'opened' | 'gated' | 'delivered';
export const MAX_GATE_CHECKS = 5;

const btnTitle = (t: string) => t.trim().slice(0, 20) || 'Continuar';

/** A automação usa o fluxo com botão (abre → [segue?] → entrega)? */
export const usesButtonFlow = (cfg: AutomationConfig) => !!cfg.button?.label?.trim() || !!cfg.followGate?.enabled;

/** Primeira mensagem (resposta privada ao comentário). */
export function openingMessage(cfg: AutomationConfig, vars: { nome?: string | null; usuario?: string | null }, flowId: string): OutMessage {
  if (!usesButtonFlow(cfg)) return { text: dmText(cfg, vars) };
  return { text: fill(cfg.dm, vars), buttons: [{ type: 'postback', title: btnTitle(cfg.button?.label || 'Quero receber'), payload: `orbit:${flowId}:open` }] };
}

/** Entrega final: texto + link como botão. */
export function deliveryMessage(cfg: AutomationConfig, vars: { nome?: string | null; usuario?: string | null }): OutMessage {
  const text = fill(cfg.delivery || 'Aqui está! 👇', vars) + (cfg.followUp?.question ? `\n\n${fill(cfg.followUp.question, vars)}` : '');
  if (cfg.link?.url) return { text, buttons: [{ type: 'web_url', title: btnTitle(cfg.link.label || 'Acessar'), url: cfg.link.url }] };
  return { text };
}

export function gateMessage(cfg: AutomationConfig, flowId: string, retry: boolean): OutMessage {
  const g = { ...DEFAULT_GATE, ...(cfg.followGate ?? {}) };
  return { text: retry ? g.notYet : g.message, buttons: [{ type: 'postback', title: btnTitle(g.buttonLabel), payload: `orbit:${flowId}:follow` }] };
}

/** A mensagem recebida é o clique no botão esperado nesta etapa? (o toque no botão chega como texto com o título). */
export function isButtonReply(cfg: AutomationConfig, stage: FlowStage, text: string, payload?: string | null): boolean {
  if (payload) return payload.endsWith(stage === 'opened' ? ':open' : ':follow');
  const t = normalize(text);
  if (!t) return false;
  if (stage === 'opened') return t === normalize(btnTitle(cfg.button?.label || 'Quero receber'));
  if (stage === 'gated') return t === normalize(btnTitle({ ...DEFAULT_GATE, ...(cfg.followGate ?? {}) }.buttonLabel)) || /(^| )(segui|seguindo|sigo|ja sigo)( |$)/.test(t);
  return false;
}

/** Próximo passo depois do clique: entrega, ou pede para seguir (com limite de verificações). */
export function nextAfterClick(cfg: AutomationConfig, stage: FlowStage, follows: boolean | null, checks: number): { send: 'delivery' | 'gate' | 'gate_retry' | 'none'; stage: FlowStage } {
  if (stage === 'delivered') return { send: 'none', stage };
  if (!cfg.followGate?.enabled || follows === true) return { send: 'delivery', stage: 'delivered' };
  if (checks >= MAX_GATE_CHECKS) return { send: 'none', stage };
  return { send: stage === 'gated' ? 'gate_retry' : 'gate', stage: 'gated' };
}

/** Texto para registro/prévia (mostra os botões entre colchetes). */
export function describeOut(m: OutMessage): string {
  return m.text + (m.buttons?.length ? '\n' + m.buttons.map((b) => `[${b.title}${b.type === 'web_url' ? ' → ' + b.url : ''}]`).join(' ') : '');
}

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
