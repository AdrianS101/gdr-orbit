// Integração oficial com a Meta (Graph API): login, Páginas do Facebook e contas profissionais do Instagram,
// publicação de vídeo (Reels), imagem e carrossel. Publicado = somente após a API devolver o id e o link.
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from '../db.ts';
import { readSecrets } from '../ai/providers.ts';
import { isAppBlock, metaFetch } from './meta-guard.ts';

export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management', 'instagram_manage_insights', 'read_insights', 'ads_read', 'instagram_manage_messages', 'instagram_manage_comments', 'pages_messaging', 'pages_read_user_content', 'pages_manage_engagement'];

export function graphVersion() {
  return getSetting<string>('meta.version', 'v23.0');
}
const G = () => `https://graph.facebook.com/${graphVersion()}`;

export function metaApp(): { appId: string; secret: string } | null {
  const s = readSecrets();
  return s.META_APP_ID && s.META_APP_SECRET ? { appId: s.META_APP_ID, secret: s.META_APP_SECRET } : null;
}

export class MetaError extends Error {
  hint: string;
  constructor(message: string, hint = '') {
    super(message);
    this.hint = hint;
  }
}

async function call(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await metaFetch(url, init);
  } catch {
    throw new MetaError('Sem conexão com a Meta.', 'Verifique a internet e tente novamente.');
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = j.error ?? {};
    const msg = String(e.error_user_msg || e.message || `HTTP ${res.status}`);
    if (e.code === 190) throw new MetaError('A conexão com a Meta expirou ou foi revogada.', 'Reconecte o perfil em Marcas → Perfis sociais.');
    if (isAppBlock(msg)) throw new MetaError('A Meta bloqueou temporariamente o app (atividade incomum na conta de desenvolvedor).', 'Entre em developers.facebook.com com sua conta, clique em "Confirmar conta" e conclua as etapas. Não precisa reconectar os perfis.');
    if (e.code === 10 || e.code === 200) throw new MetaError(`Permissão negada pela Meta: ${msg}`, 'Reconecte e aceite todas as permissões pedidas. A conta do Instagram precisa ser profissional e ligada a uma Página.');
    if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 613) throw new MetaError('Limite de uso da Meta atingido.', 'Aguarde alguns minutos e tente novamente.');
    throw new MetaError(`A Meta recusou a operação: ${msg.slice(0, 300)}`, 'Confira o formato do arquivo e tente novamente.');
  }
  return j;
}

const q = (o: Record<string, string | number | boolean>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export function oauthUrl(redirectUri: string, state: string) {
  const app = metaApp();
  if (!app) throw new MetaError('O app da Meta ainda não foi configurado.', 'Preencha o App ID e o App Secret em Configurações → Redes sociais.');
  return `https://www.facebook.com/${graphVersion()}/dialog/oauth?${q({ client_id: app.appId, redirect_uri: redirectUri, state, scope: META_SCOPES.join(','), response_type: 'code' })}`;
}

export interface MetaCandidate {
  pageId: string;
  pageName: string;
  pageToken: string;
  pagePicture: string | null;
  ig: { id: string; username: string; picture: string | null } | null;
}

/** Troca o código do login por token de longa duração e lista as Páginas e contas do Instagram. */
export async function exchangeAndList(code: string, redirectUri: string): Promise<{ candidates: MetaCandidate[]; userToken: string; expiresIn: number | null }> {
  const app = metaApp()!;
  const short = await call(`${G()}/oauth/access_token?${q({ client_id: app.appId, client_secret: app.secret, redirect_uri: redirectUri, code })}`);
  const long = await call(`${G()}/oauth/access_token?${q({ grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.secret, fb_exchange_token: short.access_token })}`);
  const pages = await call(`${G()}/me/accounts?${q({ fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}', limit: 100, access_token: long.access_token })}`);
  const candidates = (pages.data ?? []).map((p: any) => ({
    pageId: p.id,
    pageName: p.name,
    pageToken: p.access_token,
    pagePicture: p.picture?.data?.url ?? null,
    ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username, picture: p.instagram_business_account.profile_picture_url ?? null } : null,
  }));
  return { candidates, userToken: long.access_token as string, expiresIn: long.expires_in ?? null };
}

/** Verificação real: consulta a conta com o token salvo. */
export async function verifyAccount(network: string, externalId: string, token: string) {
  if (network === 'instagram') return call(`${G()}/${externalId}?${q({ fields: 'id,username', access_token: token })}`);
  return call(`${G()}/${externalId}?${q({ fields: 'id,name', access_token: token })}`);
}

// ---------- publicação ----------

export interface PublishFile {
  file: string;
  kind: 'video' | 'image';
}

async function uploadForm(url: string, fields: Record<string, string>, file?: string, extra?: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('source', new Blob([fs.readFileSync(file)]), path.basename(file));
  for (const [k, ef] of Object.entries(extra ?? {})) fd.append(k, new Blob([fs.readFileSync(ef)]), path.basename(ef));
  return call(url, { method: 'POST', body: fd });
}

/** Sobe uma imagem como foto não publicada da Página para obter uma URL pública (exigência do Instagram). */
async function hostImage(pageId: string, token: string, file: string): Promise<string> {
  const ph = await uploadForm(`${G()}/${pageId}/photos`, { published: 'false', access_token: token }, file);
  const info = await call(`${G()}/${ph.id}?${q({ fields: 'images', access_token: token })}`);
  const url = info.images?.[0]?.source;
  if (!url) throw new MetaError('Não foi possível preparar a imagem para o Instagram.', 'Tente novamente.');
  return url;
}

async function resumableVideo(igId: string, token: string, file: string, params: Record<string, string>) {
  const c = await call(`${G()}/${igId}/media`, { method: 'POST', body: new URLSearchParams({ ...params, upload_type: 'resumable', access_token: token }) });
  const size = fs.statSync(file).size;
  const up = await fetch(c.uri, { method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size) }, body: fs.readFileSync(file) });
  if (!up.ok) throw new MetaError(`Falha ao enviar o vídeo para o Instagram (${up.status}).`, 'Tente novamente.');
  return c.id as string;
}

async function waitContainer(id: string, token: string, onTick?: (msg: string) => void) {
  for (let i = 0; i < 120; i++) {
    const s = await call(`${G()}/${id}?${q({ fields: 'status_code,status', access_token: token })}`);
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new MetaError(`O Instagram não conseguiu processar a mídia (${s.status ?? s.status_code}).`, 'Confira formato e duração: Reels de 3 s a 15 min, MP4 H.264/AAC.');
    onTick?.('Instagram processando a mídia…');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new MetaError('O Instagram demorou demais para processar a mídia.', 'Tente publicar novamente em alguns minutos.');
}

export async function publishInstagram(a: { igId: string; pageId: string; token: string }, type: 'video' | 'image' | 'carousel', files: PublishFile[], caption: string, existingContainer: string | null, onStep: (msg: string, containerId?: string) => void, cover?: { offsetMs?: number; imageFile?: string } | null) {
  let container = existingContainer;
  if (!container) {
    if (type === 'video') {
      onStep('Enviando vídeo ao Instagram');
      const coverParams: Record<string, string> = {};
      if (cover?.imageFile) {
        onStep('Preparando a capa');
        coverParams.cover_url = await hostImage(a.pageId, a.token, cover.imageFile);
      } else if (cover?.offsetMs !== undefined) coverParams.thumb_offset = String(cover.offsetMs);
      container = await resumableVideo(a.igId, a.token, files[0].file, { media_type: 'REELS', caption, share_to_feed: 'true', ...coverParams });
    } else if (type === 'image') {
      onStep('Enviando imagem');
      const url = await hostImage(a.pageId, a.token, files[0].file);
      container = (await call(`${G()}/${a.igId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: url, caption, access_token: a.token }) })).id;
    } else {
      const children: string[] = [];
      for (const [i, f] of files.entries()) {
        onStep(`Enviando item ${i + 1} de ${files.length} do carrossel`);
        if (f.kind === 'video') {
          const id = await resumableVideo(a.igId, a.token, f.file, { media_type: 'VIDEO', is_carousel_item: 'true' });
          await waitContainer(id, a.token);
          children.push(id);
        } else {
          const url = await hostImage(a.pageId, a.token, f.file);
          children.push((await call(`${G()}/${a.igId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: url, is_carousel_item: 'true', access_token: a.token }) })).id);
        }
      }
      container = (await call(`${G()}/${a.igId}/media`, { method: 'POST', body: new URLSearchParams({ media_type: 'CAROUSEL', children: children.join(','), caption, access_token: a.token }) })).id;
    }
    onStep('Mídia enviada', container!);
  }
  await waitContainer(container!, a.token, (m) => onStep(m));
  onStep('Publicando');
  const pub = await call(`${G()}/${a.igId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: container!, access_token: a.token }) });
  const info = await call(`${G()}/${pub.id}?${q({ fields: 'permalink', access_token: a.token })}`);
  return { externalId: pub.id as string, permalink: (info.permalink as string) ?? null };
}

export async function publishFacebook(a: { pageId: string; token: string }, type: 'video' | 'image' | 'carousel', files: PublishFile[], caption: string, onStep: (msg: string) => void, thumbFile?: string) {
  if (type === 'video') {
    onStep('Enviando vídeo à Página');
    const v = await uploadForm(`https://graph-video.facebook.com/${graphVersion()}/${a.pageId}/videos`, { description: caption, access_token: a.token }, files[0].file, thumbFile ? { thumb: thumbFile } : undefined);
    const info = await call(`${G()}/${v.id}?${q({ fields: 'permalink_url', access_token: a.token })}`).catch(() => ({}));
    return { externalId: v.id as string, permalink: info.permalink_url ? `https://www.facebook.com${info.permalink_url}` : null };
  }
  if (type === 'image') {
    onStep('Enviando imagem à Página');
    const p = await uploadForm(`${G()}/${a.pageId}/photos`, { message: caption, access_token: a.token }, files[0].file);
    const id = p.post_id ?? p.id;
    const info = await call(`${G()}/${id}?${q({ fields: 'permalink_url', access_token: a.token })}`).catch(() => ({}));
    return { externalId: id as string, permalink: info.permalink_url ?? null };
  }
  const ids: string[] = [];
  for (const [i, f] of files.entries()) {
    if (f.kind !== 'image') throw new MetaError('O Facebook só aceita imagens em posts com várias mídias.', 'Remova os vídeos do carrossel para o Facebook.');
    onStep(`Enviando imagem ${i + 1} de ${files.length}`);
    ids.push((await uploadForm(`${G()}/${a.pageId}/photos`, { published: 'false', access_token: a.token }, f.file)).id);
  }
  const body = new URLSearchParams({ message: caption, access_token: a.token });
  ids.forEach((id, i) => body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const post = await call(`${G()}/${a.pageId}/feed`, { method: 'POST', body });
  const info = await call(`${G()}/${post.id}?${q({ fields: 'permalink_url', access_token: a.token })}`).catch(() => ({}));
  return { externalId: post.id as string, permalink: info.permalink_url ?? null };
}
