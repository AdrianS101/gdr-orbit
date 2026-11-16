// Fotos de perfil (marcas/perfis conectados e contatos da caixa de entrada) guardadas no próprio GDR Digital.
// Os links do servidor de imagens da Meta expiram em poucos dias (parâmetro "oe"), por isso a imagem é baixada
// e servida localmente; a foto do perfil conectado é renovada pela API a cada 3 dias.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { unseal } from '../lib/vault.ts';
import { metaFetch } from './meta-guard.ts';
import { graphVersion } from './meta.ts';

const DIR = path.join(config.storageDir, 'avatars');
const MAX_AGE = 3 * 24 * 3600 * 1000;

async function download(url: string | null | undefined): Promise<Buffer | null> {
  if (!url || !/^https:\/\//.test(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !/^image\//.test(r.headers.get('content-type') ?? '')) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

function save(file: string, buf: Buffer) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, buf);
}

/** Link novo da foto do perfil, pedido à API (o salvo no banco pode ter expirado). */
async function freshAccountUrl(a: any): Promise<string | null> {
  try {
    const token = unseal(a.token);
    const G = `https://graph.facebook.com/${graphVersion()}`;
    const url = a.network === 'instagram' ? `${G}/${a.external_id}?fields=profile_picture_url&access_token=${token}` : a.network === 'facebook' ? `${G}/${a.external_id}/picture?type=large&redirect=false&access_token=${token}` : null;
    if (!url) return null;
    const j: any = await (await metaFetch(url)).json();
    // Token invalidado pela Meta (senha trocada, sessão revogada): o perfil não está mais conectado de verdade.
    if (j.error?.code === 190) {
      db.prepare("UPDATE social_accounts SET status = 'error', error = ? WHERE id = ?").run('A Meta invalidou a conexão deste perfil (senha trocada ou sessão revogada por segurança). Reconecte em Marcas → Perfis sociais.', a.id);
      return null;
    }
    return a.network === 'instagram' ? j.profile_picture_url ?? null : j.data?.url ?? null;
  } catch {
    /* sem conexão ou app pausado: usa o que houver */
  }
  return null;
}

/** Arquivo local da foto de um perfil conectado (renova se tiver mais de 3 dias). */
export async function accountAvatarFile(id: string): Promise<string | null> {
  const a = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id) as any;
  if (!a) return null;
  const file = path.join(DIR, `acc_${a.id}.jpg`);
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE;
  if (fresh) return file;
  let buf = a.status !== 'manual' && a.token ? await download(await freshAccountUrl(a).then((u) => {
    if (u && u !== a.avatar) db.prepare('UPDATE social_accounts SET avatar = ? WHERE id = ?').run(u, a.id);
    return u;
  })) : null;
  if (!buf) buf = await download(a.avatar);
  if (buf) save(file, buf);
  return fs.existsSync(file) ? file : null;
}

/** Arquivo local da foto de um contato (baixada enquanto o link ainda vale; depois fica a cópia). */
export async function contactAvatarFile(id: string): Promise<string | null> {
  const c = db.prepare('SELECT id, avatar FROM contacts WHERE id = ?').get(id) as any;
  if (!c) return null;
  const file = path.join(DIR, `ct_${c.id}.jpg`);
  if (fs.existsSync(file)) return file;
  const buf = await download(c.avatar);
  if (!buf) {
    // Link expirado antes de ser copiado: pede uma foto nova na próxima verificação da caixa de entrada.
    if (c.avatar) db.prepare('UPDATE contacts SET avatar = NULL, profile_checked_at = NULL WHERE id = ?').run(c.id);
    return null;
  }
  save(file, buf);
  return file;
}

/** Endereços locais usados pela interface no lugar dos links da Meta. */
export const accountAvatarUrl = (id: string, avatar: string | null | undefined) => (avatar ? `/api/social/accounts/${id}/avatar` : null);
export const contactAvatarUrl = (id: string, avatar: string | null | undefined) => (avatar ? `/api/inbox/contacts/${id}/avatar` : null);

// ---- Capas dos posts (Resultados, Início, automações) ----
// Mesmo problema das fotos: o link salvo na sincronização expira. A capa é copiada uma vez e servida daqui;
// se o link já expirou, pede um novo à API (thumbnail_url/media_url do Instagram, full_picture do Facebook).
async function freshMediaUrl(m: any): Promise<string | null> {
  const a = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(m.account_id) as any;
  if (!a?.token || a.status === 'manual') return null;
  try {
    const G = `https://graph.facebook.com/${graphVersion()}`;
    const fields = m.network === 'instagram' ? 'thumbnail_url,media_url' : 'full_picture';
    const j: any = await (await metaFetch(`${G}/${m.external_id}?fields=${fields}&access_token=${unseal(a.token)}`)).json();
    const url = m.network === 'instagram' ? j.thumbnail_url ?? j.media_url ?? null : j.full_picture ?? null;
    if (url) db.prepare('UPDATE media_items SET thumb = ? WHERE id = ?').run(url, m.id);
    return url;
  } catch {
    return null;
  }
}

export async function mediaThumbFile(id: string): Promise<string | null> {
  const m = db.prepare('SELECT id, account_id, network, external_id, thumb FROM media_items WHERE id = ?').get(id) as any;
  if (!m) return null;
  const file = path.join(DIR, '..', 'thumbs', `${m.id}.jpg`);
  if (fs.existsSync(file)) return file;
  const buf = (await download(m.thumb)) ?? (await download(await freshMediaUrl(m)));
  if (!buf) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

export const mediaThumbUrl = (id: string, thumb: string | null | undefined) => (thumb ? `/api/media/${id}/thumb` : null);
