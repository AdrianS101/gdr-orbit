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

export type ProviderId = 'gemini' | 'anthropic' | 'claude-cli';

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
const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-flash-lite-latest'];

function geminiKey(): string | null {
  return readSecrets().GEMINI_API_KEY || process.env.GEMINI_API_KEY || null;
}

/** Chamada com limite de 20 s: se o modelo travar, vale como "sobrecarregado" e o próximo é tentado. */
async function geminiCall(model: string, key: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
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
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: req.schema, maxOutputTokens: req.maxTokens ?? 8192 },
  };
  // Modelo configurado → estável → mais novo disponível. Modelo sobrecarregado (503) ou com cota
  // esgotada (429) faz o sistema tentar de novo e, se continuar, usar o próximo da lista.
  const candidates = Array.from(new Set([model, ...GEMINI_FALLBACKS]));
  let res: Response | null = null;
  let configuredMissing = false;
  try {
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await geminiCall(m, key, body);
        if (res.status !== 503 && res.status !== 500) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
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
  if (anthropicKey()) return 'anthropic';
  if (findClaudeCli()) return 'claude-cli';
  return null;
}

/** Provedor em uso que já respondeu de verdade pelo menos uma vez. */
export function verifiedProvider(): ProviderId | null {
  const p = activeProvider();
  return p && verified()[p] ? p : null;
}

export async function generateJson<T>(req: JsonRequest, force?: ProviderId): Promise<JsonResult<T>> {
  const p = force ?? activeProvider();
  if (!p) throw new AiError('Nenhum provedor de IA está configurado.', 'Vá em Configurações > IA e conecte o Claude Code ou adicione uma chave da API da Anthropic.');
  try {
    const r = p === 'gemini' ? await geminiJson<T>(req) : p === 'anthropic' ? await anthropicJson<T>(req) : await cliJson<T>(req);
    markVerified(p, true);
    return r;
  } catch (e) {
    if (e instanceof AiError && /não está conectado|foi recusada|não está configurada|não foi encontrado/.test(e.message)) markVerified(p, false);
    throw e;
  }
}
