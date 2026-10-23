// Fila de processamento em segundo plano, persistida no SQLite.
// - Sobrevive a reinícios: trabalhos interrompidos voltam para a fila e retomam do último checkpoint.
// - Progresso em tempo real via eventos (SSE).
// - Cancelamento real: o processo do FFmpeg/transcrição é encerrado.
import { EventEmitter } from 'node:events';
import { db, now } from '../db.ts';
import { uid } from '../../../shared/timeline.ts';
import type { Job, JobType } from '../../../shared/types.ts';

export interface JobContext {
  signal: AbortSignal;
  payload: any;
  progress: (fraction: number, message?: string) => void;
  checkpoint: <T>(data?: T) => T | null;
  job: Job;
}

type Handler = (ctx: JobContext) => Promise<any>;

interface Registered {
  handler: Handler;
  concurrency: number;
  running: number;
}

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

const handlers = new Map<JobType, Registered>();
const controllers = new Map<string, AbortController>();

export function rowToJob(r: any): Job {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    progress: r.progress,
    message: r.message,
    title: r.title,
    brandId: r.brand_id,
    projectId: r.project_id,
    assetId: r.asset_id,
    error: r.error,
    result: r.result ? JSON.parse(r.result) : null,
    attempts: r.attempts,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function getJob(id: string): Job | null {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return r ? rowToJob(r) : null;
}

function emit(id: string) {
  const j = getJob(id);
  if (j) jobEvents.emit('job', j);
}

export function registerJob(type: JobType, handler: Handler, concurrency = 1) {
  handlers.set(type, { handler, concurrency, running: 0 });
}

export function enqueue(input: { type: JobType; title: string; payload?: any; brandId?: string | null; projectId?: string | null; assetId?: string | null }): string {
  const id = uid('j_');
  db.prepare(
    `INSERT INTO jobs (id, type, status, title, payload, brand_id, project_id, asset_id, created_at, message)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, 'Na fila')`,
  ).run(id, input.type, input.title, JSON.stringify(input.payload ?? {}), input.brandId ?? null, input.projectId ?? null, input.assetId ?? null, now());
  emit(id);
  setImmediate(tick);
  return id;
}

export function cancelJob(id: string): boolean {
  const j = getJob(id);
  if (!j || (j.status !== 'queued' && j.status !== 'running')) return false;
  const ctrl = controllers.get(id);
  if (ctrl) ctrl.abort();
  db.prepare("UPDATE jobs SET status = 'canceled', message = 'Cancelado por você', finished_at = ? WHERE id = ?").run(now(), id);
  emit(id);
  return true;
}

export function retryJob(id: string): boolean {
  const j = getJob(id);
  if (!j || (j.status !== 'failed' && j.status !== 'canceled')) return false;
  db.prepare("UPDATE jobs SET status = 'queued', error = NULL, message = 'Na fila (nova tentativa)', progress = 0, finished_at = NULL WHERE id = ?").run(id);
  emit(id);
  setImmediate(tick);
  return true;
}

async function run(r: any, reg: Registered) {
  const id = r.id as string;
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  reg.running++;
  db.prepare("UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, message = 'Iniciando…' WHERE id = ?").run(now(), id);
  emit(id);

  let lastWrite = 0;
  const ctx: JobContext = {
    signal: ctrl.signal,
    payload: JSON.parse(r.payload),
    job: getJob(id)!,
    progress: (fraction, message) => {
      const t = Date.now();
      const p = Math.max(0, Math.min(1, fraction));
      if (t - lastWrite > 400 || p >= 1) {
        lastWrite = t;
        if (message !== undefined) db.prepare('UPDATE jobs SET progress = ?, message = ? WHERE id = ?').run(p, message, id);
        else db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(p, id);
        emit(id);
      }
    },
    checkpoint: <T>(data?: T) => {
      if (data !== undefined) {
        db.prepare('UPDATE jobs SET checkpoint = ? WHERE id = ?').run(JSON.stringify(data), id);
        return data;
      }
      const c = db.prepare('SELECT checkpoint FROM jobs WHERE id = ?').get(id) as { checkpoint: string | null };
      return c?.checkpoint ? (JSON.parse(c.checkpoint) as T) : null;
    },
  };

  try {
    const result = await reg.handler(ctx);
    if (!ctrl.signal.aborted) {
      db.prepare("UPDATE jobs SET status = 'done', progress = 1, message = 'Concluído', result = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result ?? null), now(), id);
    }
  } catch (e: any) {
    if (!ctrl.signal.aborted) {
      const msg = String(e?.message ?? e).slice(0, 1000);
      console.error(`[job ${r.type} ${id}]`, msg, e?.stderr ? '\n' + String(e.stderr).slice(-2000) : '');
      db.prepare("UPDATE jobs SET status = 'failed', error = ?, message = 'Falhou', finished_at = ? WHERE id = ?").run(msg, now(), id);
    }
  } finally {
    controllers.delete(id);
    reg.running--;
    emit(id);
    setImmediate(tick);
  }
}

function tick() {
  for (const [type, reg] of handlers) {
    while (reg.running < reg.concurrency) {
      const r = db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND type = ? ORDER BY created_at LIMIT 1").get(type);
      if (!r) break;
      // marca imediatamente para não ser pego duas vezes
      db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run((r as any).id);
      void run(r, reg);
    }
  }
}

export function startQueue() {
  // Trabalhos que estavam rodando quando o servidor parou voltam para a fila (retomam do checkpoint).
  // Publicação não é retomada sozinha (evita post duplicado): fica como falha para você conferir.
  db.prepare("UPDATE jobs SET status = 'failed', error = 'Interrompido pelo desligamento. Confira no calendário se publicou e tente de novo.' WHERE status = 'running' AND type = 'publish'").run();
  db.prepare("UPDATE posts SET status = 'failed' WHERE status = 'publishing'").run();
  const n = db.prepare("UPDATE jobs SET status = 'queued', message = 'Retomando após reinício' WHERE status = 'running'").run();
  if (Number(n.changes) > 0) console.log(`[fila] ${n.changes} trabalho(s) retomado(s) após reinício`);
  setInterval(tick, 1000).unref();
  tick();
}
