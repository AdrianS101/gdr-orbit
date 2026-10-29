// Tela de cortes (estilo Vizard): lista os cortes gerados de um vídeo, com nota, trecho e exportação,
// e aplica ações em massa (exportar, excluir, mandar para o calendário, aplicar uma edição).
import type { FastifyInstance } from 'fastify';
import { db, now } from '../db.ts';
import { badRequest } from '../lib/errors.ts';
import { rowToAsset, rowToBrand } from '../lib/mappers.ts';
import { enqueue } from '../jobs/queue.ts';
import { availableEncoders } from '../lib/ffmpeg.ts';
import { defaultCaptionY, makeFormat, uid } from '../../../shared/timeline.ts';
import { applyAction, type ActionContext, type EditAction } from '../../../shared/edit-actions.ts';
import type { Asset, Timeline } from '../../../shared/types.ts';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../config.ts';
import { assetPath } from '../lib/storage.ts';
import { autoReframe, detectPeople, type ReframeTarget } from '../lib/reframe.ts';

/** Arquivo leve para análise (proxy 540p se existir). */
function analysisFile(a: any) {
  const px = assetPath(a.brand_id, a.id, 'proxy');
  return fs.existsSync(px) ? px : assetPath(a.brand_id, a.id, 'original', a.ext);
}

function frameJpeg(file: string, t: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'mjpeg', 'pipe:1'], { windowsHide: true });
    const out: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('Não foi possível ler o quadro do vídeo.'))));
  });
}

const validTarget = (t: any): ReframeTarget | null =>
  t && ['largest', 'left', 'right', 'center'].includes(t.mode) ? { mode: t.mode } : t?.mode === 'pick' && Number.isFinite(Number(t.x)) ? { mode: 'pick', x: Math.min(1, Math.max(0, Number(t.x))) } : null;

function clipRows(assetId: string) {
  return db.prepare("SELECT * FROM projects WHERE json_extract(clip_meta, '$.assetId') = ? ORDER BY created_at").all(assetId) as any[];
}

async function exportProject(p: any, tl: Timeline) {
  const encs = await availableEncoders();
  const encoder = encs.includes('h264_qsv') ? 'h264_qsv' : encs.includes('h264_nvenc') ? 'h264_nvenc' : 'libx264';
  const settings = { width: tl.format.width, height: tl.format.height, fps: tl.format.fps, quality: 'high' as const, encoder: encoder as any };
  return enqueue({ type: 'render', title: `Exportando "${p.name}" (${settings.width}x${settings.height})`, brandId: p.brand_id, projectId: p.id, payload: { projectId: p.id, timeline: tl, settings, revision: p.revision, name: p.name } });
}

export async function clipRoutes(app: FastifyInstance) {
  app.get('/api/assets/:id/clips', async (req) => {
    const id = (req.params as any).id;
    return clipRows(id).map((p) => {
      const ex = db.prepare('SELECT id, file, size, revision, created_at FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(p.id) as any;
      const job = db.prepare("SELECT id, status, progress, message, error FROM jobs WHERE project_id = ? AND type = 'render' ORDER BY created_at DESC LIMIT 1").get(p.id) as any;
      const tl = JSON.parse(p.timeline) as Timeline;
      const dur = tl.clips.reduce((n, c) => n + (c.out - c.in) / c.speed, 0);
      return {
        id: p.id, name: p.name, status: p.status, revision: p.revision, createdAt: p.created_at, duration: dur, format: tl.format.preset,
        meta: JSON.parse(p.clip_meta),
        export: ex ? { id: ex.id, size: ex.size, current: ex.revision === p.revision, createdAt: ex.created_at } : null,
        job: job && (job.status === 'queued' || job.status === 'running' || job.status === 'failed') ? job : null,
      };
    });
  });

  // Seletor "quem focar": um quadro do vídeo com as pessoas encontradas, para clicar em quem seguir.
  app.get('/api/assets/:id/people', async (req) => {
    const a = db.prepare('SELECT * FROM assets WHERE id = ?').get((req.params as any).id) as any;
    if (!a || a.kind !== 'video') throw badRequest('Vídeo não encontrado.');
    const meta = JSON.parse(a.meta);
    const t = Math.min(Math.max(0, Number((req.query as any).t) || (meta.duration ?? 10) * 0.3), Math.max(0, (meta.duration ?? 1) - 0.5));
    const file = analysisFile(a);
    const [jpg, boxes] = await Promise.all([frameJpeg(file, t), detectPeople(file, meta.width, meta.height, [{ key: 'f', t }])]);
    return { t, image: 'data:image/jpeg;base64,' + jpg.toString('base64'), people: (boxes.get('f') ?? []).map((b) => ({ cx: b.cx, cy: b.cy, w: b.w, h: b.h })) };
  });

  app.post('/api/clips/bulk', async (req) => {
    const b = (req.body ?? {}) as { ids: string[]; action: 'export' | 'delete' | 'post' | 'apply'; edit?: EditAction | { type: 'no_captions' }; format?: '9:16' | '1:1' | '16:9'; reframe?: ReframeTarget };
    if (!Array.isArray(b.ids) || !b.ids.length) throw badRequest('Selecione ao menos um corte.');
    const rows = b.ids.map((id) => db.prepare('SELECT * FROM projects WHERE id = ? AND clip_meta IS NOT NULL').get(id) as any).filter(Boolean);
    const out: { id: string; ok: boolean; detail?: string; jobId?: string; postId?: string }[] = [];
    for (const p of rows) {
      try {
        if (b.action === 'delete') {
          db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
          out.push({ id: p.id, ok: true });
        } else if (b.action === 'export') {
          out.push({ id: p.id, ok: true, jobId: await exportProject(p, JSON.parse(p.timeline)) });
        } else if (b.action === 'post') {
          // Rascunho no calendário com o vídeo exportado mais recente (é preciso exportar antes).
          const ex = db.prepare('SELECT id FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(p.id) as any;
          if (!ex) throw new Error('Exporte o corte antes de agendar.');
          const meta = JSON.parse(p.clip_meta);
          const postId = uid('po_');
          db.prepare("INSERT INTO posts (id, brand_id, project_id, type, media, caption, captions, status, scheduled_at, timezone, created_at, updated_at) VALUES (?, ?, ?, 'video', ?, ?, '{}', 'draft', NULL, 'America/Sao_Paulo', ?, ?)").run(postId, p.brand_id, p.id, JSON.stringify([{ source: 'export', id: ex.id }]), String(meta.hook || meta.title || '').slice(0, 2200), now(), now());
          out.push({ id: p.id, ok: true, postId });
        } else if (b.action === 'apply') {
          let tl = JSON.parse(p.timeline) as Timeline;
          if (b.format) {
            const format = makeFormat(b.format, undefined, tl.format.fps);
            tl = { ...tl, format, captions: { ...tl.captions, style: { ...tl.captions.style, posY: Math.min(tl.captions.style.posY, defaultCaptionY(format) + 0.05) } } };
          }
          // Novo formato ou nova escolha de quem focar: refaz o enquadramento automático.
          if (b.format || b.reframe) {
            const meta = JSON.parse(p.clip_meta);
            const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(meta.assetId) as any;
            const am = a ? JSON.parse(a.meta) : {};
            if (a && am.width && am.height) tl = (await autoReframe(analysisFile(a), { width: am.width, height: am.height }, [tl], validTarget(b.reframe) ?? { mode: 'largest' })).timelines[0];
          } else if (b.edit?.type === 'no_captions') {
            tl = { ...tl, captions: { ...tl.captions, cues: [] } };
          } else if (b.edit) {
            const meta = JSON.parse(p.clip_meta);
            const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(meta.assetId) as any;
            const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(p.brand_id));
            const t = db.prepare('SELECT words FROM transcripts WHERE asset_id = ?').get(meta.assetId) as any;
            const assets: Record<string, Asset> = a ? { [a.id]: rowToAsset(a) } : {};
            for (const r of db.prepare("SELECT * FROM assets WHERE brand_id = ? AND kind IN ('image','audio','video') AND status = 'ready'").all(p.brand_id) as any[]) assets[r.id] = rowToAsset(r);
            const ctx: ActionContext = { transcripts: t ? { [meta.assetId]: JSON.parse(t.words) } : {}, assets, brand: { colors: brand.profile.colors.map((c) => c.hex), logoAssetId: brand.profile.logoAssetId } };
            tl = applyAction(tl, b.edit as EditAction, ctx).timeline;
          } else throw new Error('Nada para aplicar.');
          db.prepare('UPDATE projects SET timeline = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(tl), now(), p.id);
          out.push({ id: p.id, ok: true });
        }
      } catch (e) {
        out.push({ id: p.id, ok: false, detail: (e as Error).message });
      }
    }
    return { results: out };
  });
}
