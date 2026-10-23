import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { db, now } from '../db.ts';
import { config } from '../config.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { assetPath, rmrf } from '../lib/storage.ts';
import { rowToAsset } from '../lib/mappers.ts';
import { sendFile } from '../lib/http.ts';
import { readFontNames } from '../lib/fonts.ts';
import { enqueue } from '../jobs/queue.ts';
import { TRANSCRIBE_MODELS } from '../jobs/transcribe.ts';
import { uid } from '../../../shared/timeline.ts';
import { denoiseFilter } from '../../../shared/keyframes.ts';
import { runCapture } from '../lib/ffmpeg.ts';

const EXT_KIND: Record<string, string> = {
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.avi': 'video', '.m4v': 'video', '.mts': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio', '.ogg': 'audio', '.flac': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.ttf': 'font', '.otf': 'font',
};

export function kindFor(name: string) {
  const ext = path.extname(name).toLowerCase();
  const kind = EXT_KIND[ext];
  if (!kind) throw badRequest(`O formato "${ext || 'sem extensão'}" não é suportado.`, 'Use vídeo (MP4, MOV, MKV, WEBM), áudio (MP3, WAV, M4A), imagem (PNG, JPG, WEBP) ou fonte (TTF, OTF).');
  return { ext, kind };
}

function ensureBrand(id: string) {
  if (!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(id)) throw notFound('Marca');
}

/** Registra um arquivo já copiado para a pasta temporária: evita duplicados e inicia o processamento. */
export function registerFile(brandId: string, tmp: string, name: string, size: number, sha256: string, source: string, sourceRef: string | null = null) {
  const { ext, kind } = kindFor(name);
  const dup = db.prepare('SELECT * FROM assets WHERE brand_id = ? AND sha256 = ?').get(brandId, sha256);
  if (dup) {
    rmrf(tmp);
    return { asset: rowToAsset(dup), duplicate: true };
  }
  const id = uid('a_');
  const dest = assetPath(brandId, id, 'original', ext);
  fs.renameSync(tmp, dest);
  let meta = {};
  let status = 'processing';
  if (kind === 'font') {
    const names = readFontNames(fs.readFileSync(dest));
    if (!names) {
      rmrf(dest);
      throw badRequest('Não foi possível ler esta fonte.', 'Envie um arquivo TTF ou OTF válido.');
    }
    meta = { family: names.family, style: names.style };
    status = 'ready';
  }
  db.prepare(
    'INSERT INTO assets (id, brand_id, kind, name, ext, size, sha256, meta, status, source, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, brandId, kind, name, ext, size, sha256, JSON.stringify(meta), status, source, sourceRef, now());
  if (kind !== 'font') enqueue({ type: 'ingest', title: `Preparando "${name}"`, brandId, assetId: id, payload: { assetId: id } });
  return { asset: rowToAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id)), duplicate: false };
}

export async function assetRoutes(app: FastifyInstance) {
  app.get('/api/assets', async (req) => {
    const q = req.query as { brandId?: string; kind?: string; search?: string };
    const where: string[] = [];
    const args: any[] = [];
    if (q.brandId) {
      where.push('brand_id = ?');
      args.push(q.brandId);
    }
    if (q.kind) {
      where.push('kind = ?');
      args.push(q.kind);
    }
    if (q.search) {
      where.push('(name LIKE ? OR tags LIKE ?)');
      args.push(`%${q.search}%`, `%${q.search}%`);
    }
    const rows = db.prepare(`SELECT * FROM assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`).all(...args);
    return rows.map(rowToAsset);
  });

  app.get('/api/assets/:id', async (req) => {
    const r = db.prepare('SELECT * FROM assets WHERE id = ?').get((req.params as any).id);
    if (!r) throw notFound('Arquivo');
    return rowToAsset(r);
  });

  // Envio pelo navegador (streaming, sem carregar tudo na memória)
  app.post('/api/brands/:brandId/assets', async (req) => {
    const brandId = (req.params as any).brandId;
    ensureBrand(brandId);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest('Nenhum arquivo foi enviado.');
    kindFor(file.filename);
    const tmp = path.join(config.tmpDir, `upload-${uid()}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(file.file, tap, fs.createWriteStream(tmp));
    } catch (e) {
      rmrf(tmp);
      throw new AppError(400, 'O envio foi interrompido.', 'Tente enviar o arquivo novamente.');
    }
    if (file.file.truncated) {
      rmrf(tmp);
      throw badRequest('O arquivo é maior que o limite permitido (20 GB).');
    }
    return registerFile(brandId, tmp, file.filename, size, hash.digest('hex'), 'upload');
  });

  // Importação de um arquivo que já está neste computador (evita reenviar arquivos grandes)
  app.post('/api/brands/:brandId/assets/import-path', async (req) => {
    const brandId = (req.params as any).brandId;
    ensureBrand(brandId);
    const { filePath } = (req.body ?? {}) as { filePath?: string };
    const src = String(filePath ?? '').trim().replace(/^"|"$/g, '');
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw badRequest('Arquivo não encontrado nesse caminho.', 'Copie o caminho completo do arquivo (ex.: C:\\Users\\voce\\Videos\\video.mp4).');
    const name = path.basename(src);
    kindFor(name);
    const tmp = path.join(config.tmpDir, `import-${uid()}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(fs.createReadStream(src), tap, fs.createWriteStream(tmp));
    return registerFile(brandId, tmp, name, size, hash.digest('hex'), 'local');
  });

  app.patch('/api/assets/:id', async (req) => {
    const id = (req.params as any).id;
    const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!r) throw notFound('Arquivo');
    const { name, tags } = (req.body ?? {}) as { name?: string; tags?: string[] };
    if (name !== undefined && String(name).trim()) db.prepare('UPDATE assets SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 200), id);
    if (Array.isArray(tags)) db.prepare('UPDATE assets SET tags = ? WHERE id = ?').run(JSON.stringify(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30)), id);
    return rowToAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
  });

  app.delete('/api/assets/:id', async (req) => {
    const id = (req.params as any).id;
    const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (!r) throw notFound('Arquivo');
    const used = db.prepare('SELECT name FROM projects WHERE timeline LIKE ?').all(`%"${id}"%`) as { name: string }[];
    if (used.length) throw new AppError(409, `Este arquivo está em uso em: ${used.map((u) => u.name).join(', ')}.`, 'Remova-o desses projetos antes de excluir.');
    const brandLogo = db.prepare('SELECT name FROM brands WHERE profile LIKE ?').get(`%"logoAssetId":"${id}"%`) as any;
    if (brandLogo) throw new AppError(409, `Este arquivo é o logo da marca ${brandLogo.name}.`, 'Escolha outro logo no perfil da marca antes de excluir.');
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    for (const k of ['original', 'proxy', 'waveform', 'filmstrip', 'poster'] as const) rmrf(assetPath(r.brand_id, r.id, k, r.ext));
    return { ok: true };
  });

  // ---- mídia derivada ----
  const fileOf = (id: string) => {
    const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (!r) throw notFound('Arquivo');
    return r;
  };
  app.get('/api/assets/:id/media/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const r = fileOf(id);
    const map: Record<string, string> = {
      proxy: assetPath(r.brand_id, r.id, 'proxy'),
      waveform: assetPath(r.brand_id, r.id, 'waveform'),
      filmstrip: assetPath(r.brand_id, r.id, 'filmstrip'),
      poster: assetPath(r.brand_id, r.id, 'poster'),
      original: assetPath(r.brand_id, r.id, 'original', r.ext),
    };
    const f = map[kind];
    if (!f) throw notFound('Mídia');
    return sendFile(req, reply, f, { cache: kind !== 'original', downloadName: (req.query as any).download ? r.name : undefined });
  });

  // Amostra de até 15 s com a MESMA cadeia de redução de ruído da exportação (a prévia comum toca o original).
  app.get('/api/assets/:id/denoise-sample', async (req, reply) => {
    const r = fileOf((req.params as any).id);
    const q = req.query as { from?: string; level?: string };
    const level = q.level === 'strong' ? 'strong' : q.level === 'light' ? 'light' : null;
    const from = Math.max(0, Number(q.from) || 0);
    const chain = ['aresample=48000', denoiseFilter(level ?? undefined)].filter(Boolean).join(',');
    try {
      const buf = await runCapture(config.ffmpeg, ['-v', 'error', '-ss', String(from), '-t', '15', '-i', assetPath(r.brand_id, r.id, 'original', r.ext), '-vn', '-af', chain, '-ac', '2', '-b:a', '160k', '-f', 'mp3', 'pipe:1']);
      return reply.type('audio/mpeg').header('cache-control', 'no-store').send(buf);
    } catch (e) {
      throw new AppError(500, 'Não foi possível gerar a amostra de áudio.', `Verifique se o arquivo tem áudio. Detalhe: ${(e as Error).message}`);
    }
  });

  // ---- transcrição ----
  app.get('/api/assets/:id/transcript', async (req) => {
    const t = db.prepare('SELECT * FROM transcripts WHERE asset_id = ?').get((req.params as any).id) as any;
    if (!t) return null;
    return { assetId: t.asset_id, language: t.language, model: t.model, text: t.text, words: JSON.parse(t.words), createdAt: t.created_at };
  });

  app.get('/api/transcribe/models', async () => TRANSCRIBE_MODELS);

  app.post('/api/assets/:id/transcribe', async (req) => {
    const id = (req.params as any).id;
    const r = fileOf(id);
    const meta = JSON.parse(r.meta);
    if (r.status !== 'ready') throw new AppError(409, 'O arquivo ainda está sendo preparado.', 'Aguarde a preparação terminar e tente novamente.');
    if (!meta.hasAudio) throw badRequest('Este arquivo não tem áudio.', 'A transcrição precisa de uma faixa de áudio com fala.');
    const { model = 'Xenova/whisper-small' } = (req.body ?? {}) as { model?: string };
    if (!TRANSCRIBE_MODELS[model]) throw badRequest('Modelo de transcrição desconhecido.');
    const existing = db.prepare("SELECT id FROM jobs WHERE type = 'transcribe' AND asset_id = ? AND status IN ('queued','running')").get(id) as any;
    if (existing) return { jobId: existing.id, already: true };
    const jobId = enqueue({ type: 'transcribe', title: `Transcrevendo "${r.name}"`, brandId: r.brand_id, assetId: id, payload: { assetId: id, model, language: 'portuguese' } });
    return { jobId };
  });
}
