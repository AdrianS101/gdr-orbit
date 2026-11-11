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
  if (!buf) return null;
  save(file, buf);
  return file;
}

/** Endereços locais usados pela interface no lugar dos links da Meta. */
export const accountAvatarUrl = (id: string, avatar: string | null | undefined) => (avatar ? `/api/social/accounts/${id}/avatar` : null);
export const contactAvatarUrl = (id: string, avatar: string | null | undefined) => (avatar ? `/api/inbox/contacts/${id}/avatar` : null);
