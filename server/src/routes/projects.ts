import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { db, now, tx } from '../db.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { rowToBrand, rowToProjectSummary } from '../lib/mappers.ts';
import { exportPath } from '../lib/storage.ts';
import { sendFile } from '../lib/http.ts';
import { availableEncoders } from '../lib/ffmpeg.ts';
import { enqueue } from '../jobs/queue.ts';
import { emptyTimeline, even, makeFormat, timelineDuration, uid, DEFAULT_CAPTION_STYLE, defaultCaptionY } from '../../../shared/timeline.ts';
import type { FormatPreset, Timeline, VideoClip } from '../../../shared/types.ts';
import type { RenderSettings } from '../jobs/render-graph.ts';
import { generatePostCopy, NETWORKS } from '../ai/copy.ts';
import { AiError } from '../ai/providers.ts';
import { planEdit } from '../ai/edit-chat.ts';
import { rowToAsset } from '../lib/mappers.ts';

const AUTO_VERSION_EVERY_MS = 5 * 60_000;
const MAX_AUTO_VERSIONS = 40;

function getProjectRow(id: string) {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Projeto');
  return r;
}

/** Garante que a timeline é coerente e só usa arquivos da própria marca. */
function validateTimeline(tl: any, brandId: string): Timeline {
  if (!tl || tl.version !== 1 || !Array.isArray(tl.clips) || !Array.isArray(tl.overlays) || !tl.captions || !tl.format) {
    throw badRequest('Os dados da timeline estão em um formato inválido.', 'Recarregue o editor. Se persistir, restaure uma versão anterior.');
  }
  const ids = new Set<string>([...tl.clips.map((c: any) => c.assetId), ...tl.overlays.map((o: any) => o.assetId), ...tl.captions.cues.map((c: any) => c.assetId), ...(tl.music?.assetId ? [tl.music.assetId] : [])]);
  for (const id of ids) {
    const a = db.prepare('SELECT brand_id FROM assets WHERE id = ?').get(id) as any;
    if (!a) throw badRequest('A timeline usa um arquivo que não existe mais.', 'Remova o trecho correspondente.');
    if (a.brand_id !== brandId) throw new AppError(403, 'A timeline usa um arquivo de outra marca.', 'Os dados de cada marca ficam separados. Importe o arquivo nesta marca.');
  }
  for (const c of tl.clips as VideoClip[]) {
    if (!(c.out > c.in) || !(c.speed > 0)) throw badRequest('Há um trecho com tempos inválidos na timeline.');
  }
  return tl as Timeline;
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req) => {
    const { brandId } = req.query as { brandId?: string };
    const rows = brandId ? db.prepare('SELECT * FROM projects WHERE brand_id = ? ORDER BY updated_at DESC').all(brandId) : db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return rows.map(rowToProjectSummary);
  });

  app.post('/api/projects', async (req) => {
    const { brandId, name, preset = '9:16', custom, assetIds = [] } = (req.body ?? {}) as { brandId?: string; name?: string; preset?: FormatPreset; custom?: { width: number; height: number }; assetIds?: string[] };
    const br = db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId ?? '');
    if (!br) throw badRequest('Escolha a marca do projeto.');
    const brand = rowToBrand(br);
    const tl = emptyTimeline(preset);
    if (preset === 'custom') tl.format = makeFormat('custom', custom);
    tl.captions.style = { ...DEFAULT_CAPTION_STYLE, ...(brand.profile.captionStyle ?? {}), posY: defaultCaptionY(tl.format) };
    if (!brand.profile.captionStyle && brand.profile.colors[0]) tl.captions.style.highlightColor = brand.profile.colors[0].hex;
    for (const id of assetIds) {
      const a = db.prepare("SELECT * FROM assets WHERE id = ? AND brand_id = ? AND kind = 'video'").get(id, brand.id) as any;
      if (!a) continue;
      const meta = JSON.parse(a.meta);
      if (!meta.duration) continue;
      tl.clips.push({ id: uid('c_'), assetId: a.id, in: 0, out: meta.duration, speed: 1, volume: 1, fit: 'cover', focusX: 0.5, focusY: 0.5 });
    }
    const id = uid('p_');
    db.prepare('INSERT INTO projects (id, brand_id, name, status, timeline, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(
      id, brand.id, String(name ?? '').trim() || 'Novo projeto', 'draft', JSON.stringify(tl), now(), now(),
    );
    return { ...rowToProjectSummary(getProjectRow(id)), timeline: tl };
  });

  app.get('/api/projects/:id', async (req) => {
    const r = getProjectRow((req.params as any).id);
    return { ...rowToProjectSummary(r), timeline: JSON.parse(r.timeline) };
  });

  // Salvamento (automático ou manual). baseRevision evita sobrescrever alterações feitas em outra aba.
  app.put('/api/projects/:id', async (req) => {
    const id = (req.params as any).id;
    const body = (req.body ?? {}) as { timeline?: Timeline; baseRevision?: number; name?: string; status?: string };
    return tx(() => {
      const r = getProjectRow(id);
      if (body.baseRevision !== undefined && body.baseRevision !== r.revision) {
        throw new AppError(409, 'Este projeto foi alterado em outra janela.', 'Recarregue o editor para ver a versão mais recente. Suas alterações locais podem ser recuperadas pelo histórico de versões.', 'conflito');
      }
      let timeline = r.timeline as string;
      if (body.timeline) timeline = JSON.stringify(validateTimeline(body.timeline, r.brand_id));
      const name = body.name !== undefined ? String(body.name).trim().slice(0, 120) || r.name : r.name;
      const status = body.status && ['draft', 'editing', 'review', 'approved'].includes(body.status) ? body.status : body.timeline && r.status === 'draft' ? 'editing' : r.status;
      const revision = r.revision + 1;
      db.prepare('UPDATE projects SET timeline = ?, name = ?, status = ?, revision = ?, updated_at = ? WHERE id = ?').run(timeline, name, status, revision, now(), id);
      if (body.timeline) {
        const last = db.prepare('SELECT created_at FROM project_versions WHERE project_id = ? AND auto = 1 ORDER BY created_at DESC LIMIT 1').get(id) as any;
        if (!last || Date.now() - Date.parse(last.created_at) > AUTO_VERSION_EVERY_MS) {
          db.prepare('INSERT INTO project_versions (id, project_id, revision, label, auto, timeline, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(uid('v_'), id, revision, null, timeline, now());
          db.prepare(
            `DELETE FROM project_versions WHERE project_id = ? AND auto = 1 AND id NOT IN (SELECT id FROM project_versions WHERE project_id = ? AND auto = 1 ORDER BY created_at DESC LIMIT ?)`,
          ).run(id, id, MAX_AUTO_VERSIONS);
        }
      }
      return { revision, updatedAt: now(), status, name };
    });
  });

  app.delete('/api/projects/:id', async (req) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });

  // ---- versões ----
  app.get('/api/projects/:id/versions', async (req) => {
    const rows = db.prepare('SELECT id, revision, label, auto, created_at, timeline FROM project_versions WHERE project_id = ? ORDER BY created_at DESC').all((req.params as any).id) as any[];
    return rows.map((v) => ({ id: v.id, revision: v.revision, label: v.label, auto: !!v.auto, createdAt: v.created_at, duration: timelineDuration(JSON.parse(v.timeline)) }));
  });

  app.post('/api/projects/:id/versions', async (req) => {
    const id = (req.params as any).id;
    const r = getProjectRow(id);
    const { label } = (req.body ?? {}) as { label?: string };
    const vid = uid('v_');
    db.prepare('INSERT INTO project_versions (id, project_id, revision, label, auto, timeline, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(vid, id, r.revision, String(label ?? '').slice(0, 80) || 'Versão salva', r.timeline, now());
    return { id: vid };
  });

  app.get('/api/projects/:id/versions/:vid', async (req) => {
    const { id, vid } = req.params as any;
    const v = db.prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?').get(vid, id) as any;
    if (!v) throw notFound('Versão');
    return { id: v.id, timeline: JSON.parse(v.timeline), createdAt: v.created_at, label: v.label };
  });

  // Backup do projeto (timeline + versões nomeadas), em JSON.
  app.get('/api/projects/:id/backup', async (req, reply) => {
    const r = getProjectRow((req.params as any).id);
    const versions = db.prepare('SELECT * FROM project_versions WHERE project_id = ? AND auto = 0').all(r.id) as any[];
    const data = {
      kind: 'gdr-orbit-project',
      exportedAt: now(),
      project: { id: r.id, brandId: r.brand_id, name: r.name, status: r.status, revision: r.revision, timeline: JSON.parse(r.timeline) },
      versions: versions.map((v) => ({ label: v.label, createdAt: v.created_at, timeline: JSON.parse(v.timeline) })),
    };
    reply.header('Content-Disposition', `attachment; filename="${r.name.replace(/[^\w.-]+/g, '_')}.orbit.json"`);
    return data;
  });

  // ---- exportação ----
  app.get('/api/render/options', async () => ({ encoders: await availableEncoders() }));

  app.post('/api/projects/:id/export', async (req) => {
    const id = (req.params as any).id;
    const r = getProjectRow(id);
    const tl = JSON.parse(r.timeline) as Timeline;
    if (!tl.clips.length) throw badRequest('A timeline está vazia.', 'Adicione um vídeo ao projeto antes de exportar.');
    const notReady = tl.clips.map((c) => db.prepare("SELECT name FROM assets WHERE id = ? AND status != 'ready'").get(c.assetId) as any).filter(Boolean);
    if (notReady.length) throw new AppError(409, `Ainda preparando: ${notReady[0].name}.`, 'Aguarde a preparação dos arquivos terminar.');
    const body = (req.body ?? {}) as Partial<RenderSettings> & { scale?: number };
    const scale = [0.5, 0.6667, 1, 2].includes(Number(body.scale)) ? Number(body.scale) : 1;
    const settings: RenderSettings = {
      width: even(tl.format.width * scale),
      height: even(tl.format.height * scale),
      fps: [24, 25, 30, 50, 60].includes(Number(body.fps)) ? Number(body.fps) : tl.format.fps,
      quality: body.quality === 'max' || body.quality === 'standard' ? body.quality : 'high',
      encoder: 'libx264',
    };
    if (body.encoder && body.encoder !== 'libx264') {
      if (!(await availableEncoders()).includes(body.encoder)) throw badRequest('A aceleração por hardware escolhida não está disponível neste computador.', 'Use a codificação padrão (CPU).');
      settings.encoder = body.encoder;
    }
    if (settings.width > 4096 || settings.height > 4096) throw badRequest('Resolução acima do limite de 4096 px.', 'Escolha uma escala menor.');
    const jobId = enqueue({
      type: 'render',
      title: `Exportando "${r.name}" (${settings.width}x${settings.height})`,
      brandId: r.brand_id,
      projectId: id,
      payload: { projectId: id, timeline: tl, settings, revision: r.revision, name: r.name },
    });
    return { jobId };
  });

  app.get('/api/projects/:id/exports', async (req) => {
    const rows = db.prepare('SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC').all((req.params as any).id) as any[];
    return rows.map((e) => ({ id: e.id, file: e.file, size: e.size, settings: JSON.parse(e.settings), revision: e.revision, createdAt: e.created_at, exists: fs.existsSync(exportPath(e.brand_id, e.file)) }));
  });

  app.get('/api/exports/:id/file', async (req, reply) => {
    const e = db.prepare('SELECT * FROM exports WHERE id = ?').get((req.params as any).id) as any;
    if (!e) throw notFound('Exportação');
    return sendFile(req, reply, exportPath(e.brand_id, e.file), { downloadName: (req.query as any).download ? e.file : undefined });
  });

  // ---- texto da publicação ----
  app.get('/api/copy/networks', async () => Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => [k, v.label])));

  app.post('/api/projects/:id/post-copy', async (req) => {
    const id = (req.params as any).id;
    const r = getProjectRow(id);
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(r.brand_id));
    const body = (req.body ?? {}) as { network?: string; objective?: string; notes?: string; variations?: number };
    const network = body.network && NETWORKS[body.network] ? body.network : 'instagram';
    const tl = JSON.parse(r.timeline) as Timeline;
    try {
      const out = await generatePostCopy({
        brandName: brand.name,
        profile: brand.profile,
        timeline: tl,
        network,
        objective: String(body.objective ?? '').slice(0, 300),
        notes: String(body.notes ?? '').slice(0, 1000),
        variations: Math.min(3, Math.max(1, Number(body.variations) || 2)),
      });
      const lastExport = db.prepare('SELECT id FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as any;
      const draftId = uid('d_');
      const content = { ...out.data, transcriptUsed: out.transcriptUsed, model: out.model };
      db.prepare('INSERT INTO post_drafts (id, brand_id, project_id, export_id, network, objective, content, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        draftId, brand.id, id, lastExport?.id ?? null, network, body.objective ?? null, JSON.stringify(content), out.provider, 'draft', now(), now(),
      );
      return { id: draftId, network, provider: out.provider, model: out.model, content, createdAt: now() };
    } catch (e) {
      if (e instanceof AiError) throw new AppError(503, e.message, e.hint, 'ia_indisponivel');
      throw e;
    }
  });

  // ---- edição por comando ----
  app.post('/api/projects/:id/edit-chat', async (req) => {
    const r = getProjectRow((req.params as any).id);
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(r.brand_id));
    const body = (req.body ?? {}) as { message?: string; history?: any[] };
    const message = String(body.message ?? '').trim().slice(0, 2000);
    if (!message) throw badRequest('Escreva o que você quer fazer no vídeo.');
    const tl = JSON.parse(r.timeline) as Timeline;
    const assets = (db.prepare('SELECT * FROM assets WHERE brand_id = ?').all(r.brand_id) as any[]).map(rowToAsset);
    const transcripts: Record<string, any> = {};
    for (const id of new Set(tl.clips.map((c) => c.assetId))) {
      const t = db.prepare('SELECT words FROM transcripts WHERE asset_id = ?').get(id) as any;
      if (t) transcripts[id] = JSON.parse(t.words);
    }
    try {
      return await planEdit({ message, history: Array.isArray(body.history) ? body.history : [], timeline: tl, transcripts, assets, brandName: brand.name, profile: brand.profile });
    } catch (e) {
      if (e instanceof AiError) throw new AppError(503, e.message, e.hint, 'ia_indisponivel');
      throw e;
    }
  });

  app.get('/api/projects/:id/post-drafts', async (req) => {
    const rows = db.prepare('SELECT * FROM post_drafts WHERE project_id = ? ORDER BY created_at DESC').all((req.params as any).id) as any[];
    return rows.map((d) => ({ id: d.id, network: d.network, objective: d.objective, provider: d.provider, status: d.status, content: JSON.parse(d.content), createdAt: d.created_at, updatedAt: d.updated_at }));
  });

  app.patch('/api/post-drafts/:id', async (req) => {
    const id = (req.params as any).id;
    const d = db.prepare('SELECT * FROM post_drafts WHERE id = ?').get(id) as any;
    if (!d) throw notFound('Rascunho');
    const { content } = (req.body ?? {}) as { content?: any };
    if (content) db.prepare('UPDATE post_drafts SET content = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(content), now(), id);
    return { ok: true };
  });
}
