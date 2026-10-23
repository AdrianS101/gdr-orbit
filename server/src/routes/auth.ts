// Acesso autenticado: senha local definida no primeiro uso, sessão em cookie httpOnly.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, getSetting, now, setSetting } from '../db.ts';
import { AppError, badRequest } from '../lib/errors.ts';

const COOKIE = 'orbit_session';
const DAYS = 30;

function hash(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

function verify(password: string, stored: string) {
  const [salt, h] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(token, now(), exp);
  return token;
}

export function isAuthenticated(req: FastifyRequest): boolean {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  const r = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token) as { expires_at: string } | undefined;
  return !!r && r.expires_at > now();
}

const failures = new Map<string, { n: number; until: number }>();

export async function authRoutes(app: FastifyInstance) {
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: (process.env.PUBLIC_URL ?? '').startsWith('https://'), maxAge: DAYS * 86400 };

  app.get('/api/auth/status', async (req) => ({
    setupDone: !!getSetting<string | null>('auth.password', null),
    authenticated: isAuthenticated(req),
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (getSetting<string | null>('auth.password', null)) throw new AppError(409, 'A senha de acesso já foi criada.', 'Use a tela de entrada.');
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || password.length < 8) throw badRequest('A senha precisa ter pelo menos 8 caracteres.', 'Escolha uma senha mais longa.');
    setSetting('auth.password', hash(password));
    reply.setCookie(COOKIE, createSession(), cookieOpts);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.until > Date.now()) throw new AppError(429, 'Muitas tentativas seguidas.', 'Aguarde um minuto e tente de novo.');
    const { password } = (req.body ?? {}) as { password?: string };
    const stored = getSetting<string | null>('auth.password', null);
    if (!stored) throw new AppError(409, 'Nenhuma senha foi criada ainda.', 'Recarregue a página para criar a senha de acesso.');
    if (!password || !verify(password, stored)) {
      const n = (f?.n ?? 0) + 1;
      failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      throw new AppError(401, 'Senha incorreta.', 'Confira a senha e tente novamente.');
    }
    failures.delete(ip);
    reply.setCookie(COOKIE, createSession(), cookieOpts);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    const stored = getSetting<string>('auth.password', '');
    if (!current || !verify(current, stored)) throw new AppError(401, 'A senha atual está incorreta.', 'Digite a senha que você usa para entrar.');
    if (!next || next.length < 8) throw badRequest('A nova senha precisa ter pelo menos 8 caracteres.');
    setSetting('auth.password', hash(next));
    return { ok: true };
  });
}
