// Proteção de todas as chamadas à Meta: respeita o medidor de uso que a Meta devolve em cada resposta,
// pausa sozinho quando chega perto do limite ou quando o app é bloqueado, e nunca confunde isso com "reconectar".
import { getSetting, setSetting } from '../db.ts';

export interface MetaHealth {
  /** App/conta de desenvolvedor bloqueado pela Meta (precisa de ação do usuário no painel da Meta). */
  blocked: { since: string; message: string } | null;
  /** Pausa automática por uso alto (volta sozinha). */
  pausedUntil: string | null;
  usage: number;
  checkedAt: string | null;
}

let health: MetaHealth = getSetting<MetaHealth>('meta.health', { blocked: null, pausedUntil: null, usage: 0, checkedAt: null });
const save = () => setSetting('meta.health', health);
let blockRetryAt = 0;

export const isAppBlock = (msg: string) => /API access blocked|Cannot call API for app|app is restricted|has been restricted|activity incomum/i.test(msg);
const RATE = new Set([4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006, 80008]);

export function metaHealth(): MetaHealth {
  return health;
}

/** Tarefas em segundo plano (caixa de entrada, métricas, Drive) só rodam se a Meta estiver liberada e com folga. */
export function backgroundAllowed(): boolean {
  if (health.blocked && Date.now() < blockRetryAt) return false;
  if (health.pausedUntil && Date.now() < Date.parse(health.pausedUntil)) return false;
  return health.usage < 75;
}

function usageOf(res: Response): number {
  let max = 0;
  for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage']) {
    const v = res.headers.get(h);
    if (!v) continue;
    try {
      const j = JSON.parse(v);
      const walk = (o: any) => {
        if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) typeof x === 'number' && /count|time|cputime|usage/.test(k) ? (max = Math.max(max, x)) : walk(x);
      };
      walk(j);
    } catch {
      /* cabeçalho em formato inesperado */
    }
  }
  return max;
}

function pause(minutes: number) {
  health.pausedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Substitui fetch() nas chamadas à Graph API. */
export async function metaFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  const usage = usageOf(res);
  health.usage = usage;
  health.checkedAt = new Date().toISOString();
  if (usage >= 90) pause(30);
  else if (usage >= 75) pause(10);
  // Lê o corpo uma vez para classificar o erro e devolve uma cópia intacta para quem chamou.
  const text = await res.text();
  let err: any = null;
  try {
    err = JSON.parse(text).error ?? null;
  } catch {
    /* não é JSON */
  }
  if (err) {
    const msg = String(err.message ?? '');
    if (isAppBlock(msg)) {
      if (!health.blocked) health.blocked = { since: new Date().toISOString(), message: msg };
      blockRetryAt = Date.now() + 15 * 60_000; // testa de novo a cada 15 min (uma chamada só)
    } else if (RATE.has(Number(err.code))) pause(Number(err.code) === 4 ? 60 : 20);
  } else if (res.ok && health.blocked) {
    health.blocked = null; // voltou a funcionar
  }
  save();
  return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
}
