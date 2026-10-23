// Google Drive por marca: conecta uma conta Google (somente leitura), vincula pastas a marcas,
// detecta arquivos novos e importa para a Biblioteca sem duplicar. Nunca publica nada sozinho.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { db, getSetting, now, setSetting } from './db.ts';
import { config } from './config.ts';
import { AppError, badRequest, notFound } from './lib/errors.ts';
import { seal, unseal } from './lib/vault.ts';
import { readSecrets, setSecret } from './ai/providers.ts';
import { enqueue, type JobContext } from './jobs/queue.ts';
import { kindFor, registerFile } from './routes/assets.ts';
import { publicBase } from './lib/http.ts';
import { uid } from '../../shared/timeline.ts';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const MEDIA = /^(video|image|audio)\//;
const states = new Map<string, number>();

function client() {
  const s = readSecrets();
  return s.GOOGLE_CLIENT_ID && s.GOOGLE_CLIENT_SECRET ? { id: s.GOOGLE_CLIENT_ID, secret: s.GOOGLE_CLIENT_SECRET } : null;
}

let cachedToken: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const c = client();
  const sealed = getSetting<string | null>('drive.refresh', null);
  if (!c || !sealed) throw new AppError(400, 'O Google Drive não está conectado.', 'Conecte em Configurações → Google Drive.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: unseal(sealed), grant_type: 'refresh_token' }),
  });
  const j: any = await r.json();
  if (!r.ok) {
    if (j.error === 'invalid_grant') setSetting('drive.refresh', null);
    throw new AppError(401, 'A conexão com o Google Drive expirou.', 'Conecte novamente em Configurações → Google Drive.');
  }
  cachedToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cachedToken.value;
}

async function gget(url: string): Promise<any> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 404) throw new AppError(404, 'Pasta ou arquivo não encontrado no Drive.', 'Confira o link e se a conta conectada tem acesso a ela.');
    throw new AppError(502, `O Google Drive recusou a operação: ${j.error?.message ?? r.status}`, 'Tente novamente.');
  }
  return j;
}

function folderIdFrom(input: string) {
  const m = input.match(/folders\/([A-Za-z0-9_-]{10,})/) ?? input.match(/[?&]id=([A-Za-z0-9_-]{10,})/) ?? input.match(/^([A-Za-z0-9_-]{10,})$/);
  return m?.[1] ?? null;
}

async function listMedia(folderId: string) {
  const files: { id: string; name: string; mimeType: string; size?: string }[] = [];
  let page = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const j = await gget(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? `&pageToken=${page}` : ''}`);
    files.push(...j.files.filter((f: any) => MEDIA.test(f.mimeType)));
    page = j.nextPageToken ?? '';
  } while (page);
  return files.filter((f) => {
    try {
      kindFor(f.name);
      return true;
    } catch {
      return false;
    }
  });
}

function knownRefs(brandId: string) {
  return new Set((db.prepare('SELECT source_ref FROM assets WHERE brand_id = ? AND source_ref IS NOT NULL').all(brandId) as any[]).map((r) => r.source_ref));
}

/** Confere pastas e conta os arquivos novos (sem baixar). Importa só se a pasta estiver em modo automático. */
export async function checkFolders() {
  if (!getSetting('drive.refresh', null)) return;
  for (const f of db.prepare('SELECT * FROM drive_folders').all() as any[]) {
    try {
      const known = knownRefs(f.brand_id);
      const fresh = (await listMedia(f.folder_id)).filter((x) => !known.has(`drive:${x.id}`));
      db.prepare('UPDATE drive_folders SET new_count = ?, last_check = ?, error = NULL WHERE id = ?').run(fresh.length, now(), f.id);
      if (f.auto_import && fresh.length && !db.prepare("SELECT 1 FROM jobs WHERE type = 'drive' AND status IN ('queued','running') AND payload LIKE ?").get(`%${f.id}%`)) {
        enqueue({ type: 'drive', title: `Importando do Drive: ${f.name}`, brandId: f.brand_id, payload: { folderId: f.id } });
      }
    } catch (e) {
      db.prepare('UPDATE drive_folders SET error = ?, last_check = ? WHERE id = ?').run((e as Error).message, now(), f.id);
    }
  }
}

export async function driveImportHandler(ctx: JobContext) {
  const f = db.prepare('SELECT * FROM drive_folders WHERE id = ?').get(ctx.payload.folderId) as any;
  if (!f) throw new Error('A pasta foi desvinculada.');
  const known = knownRefs(f.brand_id);
  const fresh = (await listMedia(f.folder_id)).filter((x) => !known.has(`drive:${x.id}`));
  let imported = 0;
  let dup = 0;
  for (const [i, file] of fresh.entries()) {
    if (ctx.signal.aborted) break;
    ctx.progress(i / Math.max(1, fresh.length), `Baixando ${i + 1} de ${fresh.length}: ${file.name}`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: ctx.signal });
    if (!r.ok || !r.body) throw new Error(`Não foi possível baixar "${file.name}" do Drive (${r.status}).`);
    const tmp = path.join(config.tmpDir, `drive-${uid()}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _e, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body as any), tap, fs.createWriteStream(tmp));
    const res = registerFile(f.brand_id, tmp, file.name, size, hash.digest('hex'), 'drive', `drive:${file.id}`);
    if (res.duplicate) {
      db.prepare('UPDATE assets SET source_ref = COALESCE(source_ref, ?) WHERE id = ?').run(`drive:${file.id}`, res.asset.id);
      dup++;
    } else imported++;
  }
  db.prepare('UPDATE drive_folders SET new_count = 0, last_check = ? WHERE id = ?').run(now(), f.id);
  return { imported, duplicates: dup };
}

export function startDriveWatcher() {
  setInterval(() => checkFolders().catch(() => {}), 15 * 60_000).unref();
  setTimeout(() => checkFolders().catch(() => {}), 10_000).unref();
}

export async function driveRoutes(app: FastifyInstance) {
  const redirect = (req: any) => `${publicBase(req)}/api/drive/callback`;

  app.get('/api/settings/drive', async (req) => ({ configured: !!client(), connected: !!getSetting('drive.refresh', null), email: getSetting('drive.email', null), redirectUri: redirect(req) }));

  app.put('/api/settings/drive', async (req) => {
    const { clientId, clientSecret } = (req.body ?? {}) as { clientId?: string; clientSecret?: string };
    if (!clientId || !/\.apps\.googleusercontent\.com$/.test(clientId.trim())) throw badRequest('ID do cliente inválido.', 'Ele termina com ".apps.googleusercontent.com".');
    setSecret('GOOGLE_CLIENT_ID', clientId.trim());
    if (clientSecret) setSecret('GOOGLE_CLIENT_SECRET', clientSecret.trim());
    return { ok: true };
  });

  app.get('/api/drive/connect', async (req, reply) => {
    const c = client();
    if (!c) return reply.redirect('/configuracoes?driveErro=' + encodeURIComponent('Configure o ID e a chave do cliente Google primeiro.'));
    const state = crypto.randomBytes(16).toString('hex');
    states.set(state, Date.now());
    const q = new URLSearchParams({ client_id: c.id, redirect_uri: redirect(req), response_type: 'code', scope: `${SCOPE} email`, access_type: 'offline', prompt: 'consent', state });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  });

  // Retorno do login do Google (fora da sessão; validado pelo state de uso único).
  app.get('/api/drive/callback', async (req, reply) => {
    const { code, state, error } = req.query as Record<string, string>;
    const at = states.get(state);
    states.delete(state);
    if (!at || Date.now() - at > 15 * 60_000) return reply.redirect('/configuracoes?driveErro=' + encodeURIComponent('A conexão expirou. Tente de novo.'));
    if (!code) return reply.redirect('/configuracoes?driveErro=' + encodeURIComponent(error || 'Conexão cancelada.'));
    const c = client()!;
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirect(req), grant_type: 'authorization_code' }) });
    const j: any = await r.json();
    if (!r.ok || !j.refresh_token) return reply.redirect('/configuracoes?driveErro=' + encodeURIComponent(j.error_description || 'O Google não devolveu a autorização. Tente de novo.'));
    setSetting('drive.refresh', seal(j.refresh_token));
    cachedToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    try {
      const me = await gget('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
      setSetting('drive.email', me.user?.emailAddress ?? null);
    } catch {
      /* e-mail é só informativo */
    }
    return reply.redirect('/configuracoes?drive=ok');
  });

  app.post('/api/drive/disconnect', async () => {
    setSetting('drive.refresh', null);
    setSetting('drive.email', null);
    cachedToken = null;
    return { ok: true };
  });

  app.get('/api/drive/folders', async (req) => {
    const { brandId } = req.query as { brandId: string };
    return (db.prepare('SELECT * FROM drive_folders WHERE brand_id = ? ORDER BY created_at').all(brandId) as any[]).map((f) => ({ id: f.id, folderId: f.folder_id, name: f.name, autoImport: !!f.auto_import, lastCheck: f.last_check, newCount: f.new_count, error: f.error }));
  });

  app.post('/api/drive/folders', async (req) => {
    const { brandId, link } = (req.body ?? {}) as { brandId: string; link: string };
    if (!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(brandId)) throw notFound('Marca');
    const folderId = folderIdFrom(String(link ?? '').trim());
    if (!folderId) throw badRequest('Link de pasta inválido.', 'No Drive, abra a pasta e copie o endereço (contém /folders/…).');
    const meta = await gget(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`);
    if (meta.mimeType !== 'application/vnd.google-apps.folder') throw badRequest('Esse link não é de uma pasta.');
    const id = uid('df_');
    db.prepare('INSERT OR IGNORE INTO drive_folders (id, brand_id, folder_id, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, brandId, folderId, meta.name, now());
    await checkFolders();
    return { ok: true };
  });

  app.patch('/api/drive/folders/:id', async (req) => {
    const { autoImport } = (req.body ?? {}) as { autoImport?: boolean };
    db.prepare('UPDATE drive_folders SET auto_import = ? WHERE id = ?').run(autoImport ? 1 : 0, (req.params as any).id);
    return { ok: true };
  });

  app.post('/api/drive/folders/:id/check', async () => {
    await checkFolders();
    return { ok: true };
  });

  app.post('/api/drive/folders/:id/import', async (req) => {
    const f = db.prepare('SELECT * FROM drive_folders WHERE id = ?').get((req.params as any).id) as any;
    if (!f) throw notFound('Pasta');
    return { jobId: enqueue({ type: 'drive', title: `Importando do Drive: ${f.name}`, brandId: f.brand_id, payload: { folderId: f.id } }) };
  });

  app.delete('/api/drive/folders/:id', async (req) => {
    db.prepare('DELETE FROM drive_folders WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });
}
