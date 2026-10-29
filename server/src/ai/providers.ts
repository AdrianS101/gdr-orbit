// Camada de provedores de IA. Toda chamada passa por aqui; a interface nunca vê chaves.
// Provedores:
//  - anthropic: API da Anthropic (chave em data/secrets.json ou ANTHROPIC_API_KEY). Custo por uso.
//  - claude-cli: Claude Code instalado neste computador, usando o login da sua conta Claude.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { getSetting, setSetting } from '../db.ts';

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'claude-cli';

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
  /** Último teste/uso real bem-sucedido. Sem isso, o provedor não aparece como conectado. */
  verifiedAt: string | null;
  detail: string;
  costNote: string;
}

export interface JsonRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface JsonResult<T> {
  data: T;
  provider: ProviderId;
  model: string;
}

export class AiError extends Error {
  hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

// ---------- segredos (somente no servidor) ----------

export function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(config.secretsFile, 'utf8'));
  } catch {
    return {};
  }
}

export function setSecret(key: string, value: string | null) {
  const s = readSecrets();
  if (value) s[key] = value;
  else delete s[key];
  fs.writeFileSync(config.secretsFile, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function anthropicKey(): string | null {
  return readSecrets().ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null;
}

export function maskedKey(): string | null {
  const k = anthropicKey();
  return k ? `••••${k.slice(-4)}` : null;
}

// ---------- Claude Code (CLI) ----------

export function findClaudeCli(): string | null {
  const custom = getSetting<string | null>('ai.claudeCliPath', null) || process.env.CLAUDE_CLI_PATH;
  if (custom && fs.existsSync(custom)) return custom;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? [exe, 'claude.cmd'] : [exe]) {
      const f = path.join(dir, name);
      if (dir && fs.existsSync(f)) return f;
    }
  }
  // Instalação do app Claude para desktop (Windows)
  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code');
  try {
    const found: { f: string; t: number }[] = [];
    for (const v of fs.readdirSync(base)) {
      const vd = path.join(base, v);
      for (const h of fs.readdirSync(vd)) {
        const f = path.join(vd, h, exe);
        if (fs.existsSync(f)) found.push({ f, t: fs.statSync(f).mtimeMs });
      }
    }
    found.sort((a, b) => b.t - a.t);
    if (found[0]) return found[0].f;
  } catch {
    /* sem instalação desktop */
  }
  return null;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_BASE_URL|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
  return env;
}

function runCli(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: os.tmpdir(), env: cleanEnv(), windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new AiError('O Claude Code demorou demais para responder.', 'Tente novamente. Se persistir, verifique sua conexão.'));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new AiError(`Não foi possível executar o Claude Code (${e.message}).`, 'Confira o caminho do executável em Configurações > IA.'));
    });
    p.on('close', () => {
      clearTimeout(timer);
      if (!out.trim()) return reject(new AiError('O Claude Code não retornou resposta.', err.slice(-300) || 'Tente novamente.'));
      resolve(out);
    });
    p.stdin.end(stdin);
  });
}

async function cliJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
  const bin = findClaudeCli();
  if (!bin) throw new AiError('O Claude Code não foi encontrado neste computador.', 'Instale o Claude Code ou configure uma chave da API da Anthropic em Configurações > IA.');
  const model = getSetting<string>('ai.cliModel', 'opus');
  const raw = await runCli(
    bin,
    ['-p', '--output-format', 'json', '--model', model, '--no-session-persistence', '--system-prompt', req.system, '--json-schema', JSON.stringify(req.schema)],
    req.prompt,
    240_000,
  );
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new AiError('Resposta inesperada do Claude Code.', 'Atualize o Claude Code e tente novamente.');
  }
  if (j.is_error) {
    const msg = String(j.result ?? '');
    if (/not logged in|login/i.test(msg)) throw new AiError('O Claude Code não está conectado à sua conta.', `Abra um terminal, execute "${bin}" e faça login uma vez (comando /login). Depois clique em "Testar" em Configurações > IA.`);
    throw new AiError(`O Claude Code retornou um erro: ${msg.slice(0, 200)}`, 'Tente novamente em instantes.');
  }
  const data = j.structured_output ?? extractJson(String(j.result ?? ''));
  if (!data) throw new AiError('A IA não devolveu o formato esperado.', 'Tente gerar novamente.');
  return { data: data as T, provider: 'claude-cli', model: `Claude Code (${model})` };
}

function extractJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// ---------- API da Anthropic ----------

async function anthropicJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
  const apiKey = anthropicKey();
  if (!apiKey) throw new AiError('A chave da API da Anthropic não está configurada.', 'Adicione a chave em Configurações > IA, ou use o Claude Code instalado.');
  const client = new Anthropic({ apiKey });
  const model = getSetting<string>('ai.model', 'claude-opus-5-5');
  try {
    const res: any = await client.beta.messages.create({
      model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: req.schema } },
      // Se o modelo recusar por política, a API tenta automaticamente o modelo de reserva recomendado.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as any);
    if (res.stop_reason === 'refusal') throw new AiError('A IA recusou este pedido.', 'Revise o conteúdo enviado e tente novamente.');
    if (res.stop_reason === 'max_tokens') throw new AiError('A resposta ficou longa demais e foi cortada.', 'Tente novamente com menos variações.');
    const text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { data: JSON.parse(text) as T, provider: 'anthropic', model: res.model ?? model };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('A chave da API da Anthropic foi recusada.', 'Confira se a chave está correta e ativa no console da Anthropic.');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('Limite de uso da API atingido.', 'Aguarde alguns minutos e tente novamente.');
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`A API recusou a requisição: ${e.message.slice(0, 200)}`, 'Verifique o modelo configurado em Configurações > IA.');
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('Sem conexão com a API da Anthropic.', 'Verifique sua internet e tente novamente.');
    if (e instanceof Anthropic.APIError) throw new AiError(`Erro da API (${e.status}).`, 'Tente novamente em instantes.');
    throw e;
  }
}

// ---------- Google Gemini (gratuito até o limite diário) ----------

export const GEMINI_DEFAULT = 'gemini-flash-latest';
/** Modelos que ficaram sobrecarregados: são pulados por 10 minutos para não esperar à toa. */
const geminiBusy = new Map<string, number>();
const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-flash-lite-latest'];

function geminiKey(): string | null {
  return readSecrets().GEMINI_API_KEY || process.env.GEMINI_API_KEY || null;
}

/** Chamada com limite de 20 s: se o modelo travar, vale como "sobrecarregado" e o próximo é tentado. */
async function geminiCall(model: string, key: string, body: unknown, timeoutMs = 20_000): Promise<Response> {
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') return new Response(JSON.stringify({ error: { message: 'Tempo esgotado.' } }), { status: 504 });
    throw e;
  }
}

/** Escolhe o modelo "flash" mais recente disponível para a chave (se o configurado deixar de existir). */
async function latestFlash(key: string): Promise<string | null> {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  if (!r.ok) return null;
  const j: any = await r.json();
  const names: string[] = (j.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m: any) => String(m.name).replace('models/', ''))
    .filter((n: string) => /^gemini-[\d.]+-flash$/.test(n));
  names.sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]));
  return names[0] ?? null;
}

async function geminiJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
  const key = geminiKey();
  if (!key) throw new AiError('A chave do Gemini não está configurada.', 'Crie uma chave grátis em aistudio.google.com e cole em Configurações > IA.');
  let model = getSetting<string>('ai.geminiModel', GEMINI_DEFAULT);
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    // Piso de 4096: os modelos novos raciocinam antes de responder e esse raciocínio consome o limite.
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: req.schema, maxOutputTokens: Math.max(4096, req.maxTokens ?? 8192) },
  };
  // Modelo configurado → estável → mais novo disponível. Modelo sobrecarregado (503) ou com cota
  // esgotada (429) faz o sistema tentar de novo e, se continuar, usar o próximo da lista.
  const candidates = Array.from(new Set([model, ...GEMINI_FALLBACKS]));
  let res: Response | null = null;
  let configuredMissing = false;
  try {
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      if ((geminiBusy.get(m) ?? 0) > Date.now() && i < candidates.length - 1) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        // Textos longos (transcrições) levam mais: 20 s + ~2 s a cada mil caracteres, até 2 min.
        res = await geminiCall(m, key, body, Math.min(120_000, 20_000 + (req.prompt.length / 1000) * 2000));
        if (res.status !== 503 && res.status !== 500) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      if ([500, 503, 504].includes(res!.status)) geminiBusy.set(m, Date.now() + 10 * 60_000);
      if (res!.status === 404) {
        if (i === 0) configuredMissing = true;
        if (i === candidates.length - 1) {
          const alt = await latestFlash(key);
          if (alt && !candidates.includes(alt)) candidates.push(alt);
        }
      }
      if (res!.ok) {
        model = m;
        // Só troca o modelo salvo quando o configurado deixou de existir (não por sobrecarga momentânea).
        if (configuredMissing) setSetting('ai.geminiModel', m);
        break;
      }
      if (![404, 429, 500, 503, 504].includes(res!.status)) break;
    }
  } catch {
    throw new AiError('Sem conexão com o Gemini.', 'Verifique sua internet e tente novamente.');
  }
  res = res!;
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(j?.error?.message ?? res.status);
    if (res.status === 400 && /API key/i.test(msg)) throw new AiError('A chave do Gemini foi recusada.', 'Confira a chave em aistudio.google.com e cole novamente.');
    if (res.status === 403) throw new AiError('A chave do Gemini foi recusada.', 'Confira a chave em aistudio.google.com e cole novamente.');
    if (res.status === 429) throw new AiError('Limite gratuito do Gemini atingido por agora.', 'Aguarde alguns minutos (o limite é por minuto e por dia) e tente de novo.');
    if (res.status === 503 || res.status === 500 || res.status === 504) throw new AiError('Os modelos do Gemini estão sobrecarregados agora (problema temporário do Google).', 'Tente de novo em alguns minutos.');
    throw new AiError(`O Gemini retornou um erro: ${msg.slice(0, 200)}`, 'Tente novamente em instantes.');
  }
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  if (!text) throw new AiError('O Gemini não retornou resposta.', j.promptFeedback?.blockReason ? 'O pedido foi bloqueado pelo filtro do Google. Reformule.' : 'Tente novamente.');
  try {
    return { data: JSON.parse(text) as T, provider: 'gemini', model };
  } catch {
    const d = extractJson(text);
    if (!d) throw new AiError('A IA não devolveu o formato esperado.', 'Tente novamente.');
    return { data: d as T, provider: 'gemini', model };
  }
}

// ---------- Pesquisa na web (Gemini + Busca do Google) ----------

export interface ResearchResult {
  text: string;
  sources: { title: string; uri: string }[];
  queries: string[];
  model: string;
  searchedAt: string;
}

/** Pesquisa com a Busca do Google integrada ao Gemini. Devolve o texto e as fontes reais consultadas. */
export async function geminiResearch(system: string, prompt: string): Promise<ResearchResult> {
  const key = geminiKey();
  if (!key) throw new AiError('A pesquisa na web usa o Gemini, que não está configurado.', 'Adicione a chave grátis do Gemini em Configurações > IA.');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  let last = '';
  for (const m of Array.from(new Set([getSetting<string>('ai.geminiModel', GEMINI_DEFAULT), ...GEMINI_FALLBACKS]))) {
    if ((geminiBusy.get(m) ?? 0) > Date.now()) continue;
    let res: Response;
    try {
      res = await geminiCall(m, key, body, 90_000);
    } catch {
      throw new AiError('Sem conexão com o Gemini.', 'Verifique sua internet e tente novamente.');
    }
    const j: any = await res.json().catch(() => ({}));
    if ([500, 503, 504].includes(res.status)) {
      geminiBusy.set(m, Date.now() + 10 * 60_000);
      last = 'sobrecarregado';
      continue;
    }
    if (res.status === 404) continue;
    if (res.status === 429) throw new AiError('Limite gratuito do Gemini atingido por agora.', 'A pesquisa com Busca do Google tem cota diária menor. Tente mais tarde.');
    if (!res.ok) throw new AiError(`O Gemini retornou um erro: ${String(j?.error?.message ?? res.status).slice(0, 200)}`, 'Tente novamente em instantes.');
    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    const gm = cand?.groundingMetadata ?? {};
    const sources = (gm.groundingChunks ?? []).map((c: any) => ({ title: c.web?.title ?? c.web?.domain ?? 'fonte', uri: c.web?.uri ?? '' })).filter((x: any) => x.uri);
    markVerified('gemini', true);
    return { text, sources, queries: gm.webSearchQueries ?? [], model: m, searchedAt: new Date().toISOString() };
  }
  throw new AiError(last === 'sobrecarregado' ? 'Os modelos do Gemini estão sobrecarregados agora.' : 'Nenhum modelo do Gemini disponível para pesquisa.', 'Tente de novo em alguns minutos.');
}

// ---------- OpenAI (GPT) — chave de API própria, cobrança por uso (separada da assinatura do ChatGPT) ----------

function openaiKey(): string | null {
  return readSecrets().OPENAI_API_KEY || process.env.OPENAI_API_KEY || null;
}

/** Modelos preferidos, do mais indicado ao mais simples; usa o primeiro que a chave tiver. */
const OPENAI_PREFERRED = ['gpt-5.5-mini', 'gpt-5.1-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];

async function openaiModel(key: string): Promise<string> {
  const saved = getSetting<string | null>('ai.openaiModel', null);
  if (saved) return saved;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json();
    const ids: string[] = (j.data ?? []).map((m: any) => m.id);
    const pick = OPENAI_PREFERRED.find((m) => ids.includes(m)) ?? ids.filter((i) => /^gpt-[\d.]+-mini$/.test(i)).sort().pop() ?? 'gpt-4o-mini';
    setSetting('ai.openaiModel', pick);
    return pick;
  } catch {
    return 'gpt-4o-mini';
  }
}

async function openaiJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
  const key = openaiKey();
  if (!key) throw new AiError('A chave da OpenAI não está configurada.', 'Crie uma chave em platform.openai.com → API keys e cole em Configurações > IA.');
  const model = await openaiModel(key);
  // Saída estruturada estrita só quando o formato permite (todos os campos obrigatórios e sem campos extras).
  const strict = req.schema.additionalProperties === false;
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        max_completion_tokens: req.maxTokens ?? 8000,
        response_format: strict ? { type: 'json_schema', json_schema: { name: 'resposta', schema: req.schema, strict: true } } : { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new AiError('Sem conexão com a OpenAI.', 'Verifique sua internet e tente novamente.');
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(j?.error?.message ?? res.status);
    if (res.status === 401) throw new AiError('A chave da OpenAI foi recusada.', 'Confira a chave em platform.openai.com → API keys.');
    if (res.status === 429 && /quota|billing|credit/i.test(msg)) throw new AiError('A conta da OpenAI está sem saldo.', 'Adicione crédito em platform.openai.com → Billing (a assinatura do ChatGPT não vale para a API).');
    if (res.status === 429) throw new AiError('Limite de uso da OpenAI atingido por agora.', 'Aguarde um minuto e tente de novo.');
    if (res.status === 404 || /model/i.test(msg)) setSetting('ai.openaiModel', null);
    throw new AiError(`A OpenAI retornou um erro: ${msg.slice(0, 200)}`, 'Tente novamente em instantes.');
  }
  const text = j.choices?.[0]?.message?.content ?? '';
  if (j.choices?.[0]?.message?.refusal) throw new AiError('O GPT recusou este pedido.', 'Reformule e tente de novo.');
  try {
    return { data: JSON.parse(text) as T, provider: 'openai', model };
  } catch {
    const d = extractJson(text);
    if (!d) throw new AiError('A IA não devolveu o formato esperado.', 'Tente novamente.');
    return { data: d as T, provider: 'openai', model };
  }
}

// ---------- seleção ----------

function verified(): Record<string, string> {
  return getSetting<Record<string, string>>('ai.verified', {});
}

function markVerified(id: ProviderId, ok: boolean) {
  const v = verified();
  if (ok) v[id] = new Date().toISOString();
  else delete v[id];
  setSetting('ai.verified', v);
}

export function providerStatuses(): ProviderStatus[] {
  const cli = findClaudeCli();
  const v = verified();
  return [
    {
      id: 'openai',
      name: 'OpenAI (GPT)',
      configured: !!openaiKey(),
      verifiedAt: openaiKey() ? (v.openai ?? null) : null,
      detail: openaiKey() ? 'Chave configurada. Modelo: ' + (getSetting<string | null>('ai.openaiModel', null) ?? 'escolhido no primeiro uso') + '.' : 'Sem chave. Crie em platform.openai.com → API keys.',
      costNote: 'Cobrança por uso na sua conta da OpenAI (separada da assinatura do ChatGPT). Usado também como reserva quando o Gemini falhar.',
    },
    {
      id: 'gemini',
      name: 'Google Gemini (gratuito)',
      configured: !!geminiKey(),
      verifiedAt: geminiKey() ? (v.gemini ?? null) : null,
      detail: geminiKey() ? 'Chave configurada. Modelo: ' + getSetting('ai.geminiModel', GEMINI_DEFAULT) + '.' : 'Sem chave. Crie uma grátis em aistudio.google.com (Get API key).',
      costNote: 'Grátis até o limite diário do Google. Não usa tokens do Claude. O texto do pedido é enviado ao Google; o vídeo não.',
    },
    {
      id: 'claude-cli',
      name: 'Claude Code neste computador',
      configured: !!cli,
      verifiedAt: cli ? (v['claude-cli'] ?? null) : null,
      detail: cli ? `Encontrado em ${cli}. Requer login feito uma vez no terminal ("claude").` : 'Não encontrado.',
      costNote: 'Usa o plano da sua conta Claude (sem cobrança por chave de API).',
    },
    {
      id: 'anthropic',
      name: 'API da Anthropic',
      configured: !!anthropicKey(),
      verifiedAt: anthropicKey() ? (v.anthropic ?? null) : null,
      detail: anthropicKey() ? `Chave configurada (${maskedKey()}). Modelo: ${getSetting('ai.model', 'claude-opus-5-5')}.` : 'Sem chave configurada.',
      costNote: 'Cobrança por uso na sua conta da Anthropic.',
    },
  ];
}

export function activeProvider(): ProviderId | null {
  const pref = getSetting<ProviderId | 'auto'>('ai.provider', 'auto');
  const st = providerStatuses();
  if (pref !== 'auto') return st.find((s) => s.id === pref)?.configured ? pref : null;
  if (geminiKey()) return 'gemini';
  if (openaiKey()) return 'openai';
  if (anthropicKey()) return 'anthropic';
  if (findClaudeCli()) return 'claude-cli';
  return null;
}

/** Provedor em uso que já respondeu de verdade pelo menos uma vez. */
export function verifiedProvider(): ProviderId | null {
  const p = activeProvider();
  return p && verified()[p] ? p : null;
}

const TRANSIENT = /sobrecarregad|Limite|Sem conexão|sem saldo|demorou|não retornou|formato esperado|retornou um erro/;

async function runProvider<T>(p: ProviderId, req: JsonRequest): Promise<JsonResult<T>> {
  try {
    const r = p === 'gemini' ? await geminiJson<T>(req) : p === 'openai' ? await openaiJson<T>(req) : p === 'anthropic' ? await anthropicJson<T>(req) : await cliJson<T>(req);
    markVerified(p, true);
    return r;
  } catch (e) {
    if (e instanceof AiError && /não está conectado|foi recusada|não está configurada|não foi encontrado/.test(e.message)) markVerified(p, false);
    throw e;
  }
}

/** Provedores de reserva: os outros já configurados e testados, na ordem gemini → openai → anthropic → claude-cli. */
function backups(first: ProviderId): ProviderId[] {
  const v = verified();
  const has: Record<ProviderId, boolean> = { gemini: !!geminiKey(), openai: !!openaiKey(), anthropic: !!anthropicKey(), 'claude-cli': !!findClaudeCli() };
  return (['gemini', 'openai', 'anthropic', 'claude-cli'] as ProviderId[]).filter((p) => p !== first && has[p] && v[p]);
}

export async function generateJson<T>(req: JsonRequest, force?: ProviderId): Promise<JsonResult<T>> {
  const p = force ?? activeProvider();
  if (!p) throw new AiError('Nenhum provedor de IA está configurado.', 'Vá em Configurações > IA e adicione a chave do Gemini (grátis) ou da OpenAI.');
  try {
    return await runProvider<T>(p, req);
  } catch (e) {
    // No modo automático, se o provedor principal falhar por motivo passageiro, tenta os outros já testados.
    if (force || getSetting('ai.provider', 'auto') !== 'auto' || !(e instanceof AiError) || !TRANSIENT.test(e.message)) throw e;
    for (const b of backups(p)) {
      try {
        return await runProvider<T>(b, req);
      } catch {
        /* tenta o próximo */
      }
    }
    throw e;
  }
}
