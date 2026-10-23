import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.ts';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.srt': 'application/x-subrip',
};

/** Envia um arquivo com suporte a Range (necessário para o player de vídeo buscar trechos). */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, opts: { downloadName?: string; cache?: boolean } = {}) {
  if (!fs.existsSync(file)) throw new AppError(404, 'Arquivo não encontrado no armazenamento.', 'Ele pode ter sido removido da pasta de dados.');
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', type);
  reply.header('Cache-Control', opts.cache ? 'private, max-age=3600' : 'no-cache');
  if (opts.downloadName) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (m && !m[1] && m[2]) {
      start = stat.size - Number(m[2]);
      end = stat.size - 1;
    }
    if (start >= stat.size || start > end) {
      reply.code(416).header('Content-Range', `bytes */${stat.size}`);
      return reply.send();
    }
    end = Math.min(end, stat.size - 1);
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', stat.size);
  return reply.send(fs.createReadStream(file));
}

/** Endereço público do sistema (PUBLIC_URL na nuvem; no PC, o host da requisição). Usado nos retornos de OAuth. */
export function publicBase(req: FastifyRequest): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return `http://${String(req.headers.host ?? 'localhost:4310').replace('127.0.0.1', 'localhost')}`;
}
