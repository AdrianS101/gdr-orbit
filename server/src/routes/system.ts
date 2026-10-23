import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting } from '../db.ts';
import { config } from '../config.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { cancelJob, jobEvents, retryJob, rowToJob } from '../jobs/queue.ts';
import { rowToBrand, rowToProjectSummary } from '../lib/mappers.ts';
import { missingFields } from './brands.ts';
import { listFonts, resolveFontFiles, SUGGESTED_FAMILIES } from '../lib/fonts.ts';
import { sendFile } from '../lib/http.ts';
import { runCapture, availableEncoders } from '../lib/ffmpeg.ts';
import { activeProvider, verifiedProvider, AiError, generateJson, providerStatuses, setSecret, type ProviderId } from '../ai/providers.ts';
import type { Job } from '../../../shared/types.ts';

export async function systemRoutes(app: FastifyInstance) {
  // ---- fila ----
  app.get('/api/jobs', async (req) => {
    const q = req.query as { active?: string; brandId?: string; projectId?: string; assetId?: string; limit?: string };
    const where: string[] = [];
    const args: any[] = [];
    if (q.active) where.push("status IN ('queued','running')");
    if (q.brandId) (where.push('brand_id = ?'), args.push(q.brandId));
    if (q.projectId) (where.push('project_id = ?'), args.push(q.projectId));
    if (q.assetId) (where.push('asset_id = ?'), args.push(q.assetId));
    const limit = Math.min(200, Number(q.limit) || 50);
    return db.prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`).all(...args).map(rowToJob);
  });

  app.post('/api/jobs/:id/cancel', async (req) => ({ ok: cancelJob((req.params as any).id) }));
  app.post('/api/jobs/:id/retry', async (req) => ({ ok: retryJob((req.params as any).id) }));
  app.post('/api/jobs/:id/dismiss', async (req) => {
    db.prepare("DELETE FROM jobs WHERE id = ? AND status IN ('failed','canceled','done')").run((req.params as any).id);
    return { ok: true };
  });

  // Eventos em tempo real (Server-Sent Events) com o estado dos trabalhos.
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const onJob = (j: Job) => res.write(`event: job\ndata: ${JSON.stringify(j)}\n\n`);
    jobEvents.on('job', onJob);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      jobEvents.off('job', onJob);
    });
  });

  // ---- início ----
  app.get('/api/home', async (req) => {
    const { brandId } = req.query as { brandId?: string };
    const bw = brandId ? 'WHERE brand_id = ?' : '';
    const args = brandId ? [brandId] : [];
    const projects = db.prepare(`SELECT * FROM projects ${bw} ORDER BY updated_at DESC LIMIT 12`).all(...args).map(rowToProjectSummary);
    const failed = db.prepare(`SELECT * FROM jobs WHERE status = 'failed' ${brandId ? 'AND brand_id = ?' : ''} ORDER BY finished_at DESC LIMIT 10`).all(...args).map(rowToJob);
    const active = db.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running') ${brandId ? 'AND brand_id = ?' : ''} ORDER BY created_at`).all(...args).map(rowToJob);
    const exports = (db.prepare(`SELECT e.*, p.name AS project_name FROM exports e JOIN projects p ON p.id = e.project_id ${brandId ? 'WHERE e.brand_id = ?' : ''} ORDER BY e.created_at DESC LIMIT 6`).all(...args) as any[]).map((e) => ({
      id: e.id, projectId: e.project_id, projectName: e.project_name, file: e.file, size: e.size, createdAt: e.created_at,
    }));
    const brands = (db.prepare(`SELECT * FROM brands ${brandId ? 'WHERE id = ?' : ''} ORDER BY name`).all(...args) as any[]).map((r) => {
      const b = rowToBrand(r);
      return { id: b.id, name: b.name, missing: missingFields(b.profile) };
    });
    const review = projects.filter((p) => p.status === 'review');
    return { projects, failed, active, exports, brands, review, ai: verifiedProvider() };
  });

  // ---- fontes ----
  app.get('/api/fonts', async (req) => {
    const { brandId } = req.query as { brandId?: string };
    const fam = listFonts(brandId);
    const all = [...fam.entries()].map(([family, list]) => ({ family, source: list[0].source, styles: list.map((l) => l.style) }));
    const suggested = SUGGESTED_FAMILIES.filter((f) => fam.has(f));
    all.sort((a, b) => (a.source === b.source ? a.family.localeCompare(b.family) : a.source === 'marca' ? -1 : 1));
    return { suggested, fonts: all };
  });

  app.get('/api/fonts/file', async (req, reply) => {
    const { family, bold, brandId } = req.query as { family?: string; bold?: string; brandId?: string };
    const f = resolveFontFiles(String(family ?? ''), bold === '1', brandId)[0];
    if (!f) throw new AppError(404, `A fonte "${family}" não está instalada.`, 'Escolha outra fonte ou envie o arquivo da fonte na Biblioteca da marca.');
    return sendFile(req, reply, f.file, { cache: true });
  });

  // ---- configurações ----
  app.get('/api/settings/ai', async () => ({
    providers: providerStatuses(),
    preference: getSetting('ai.provider', 'auto'),
    active: activeProvider(),
    model: getSetting('ai.model', 'claude-opus-5-5'),
    cliModel: getSetting('ai.cliModel', 'opus'),
  }));

  app.put('/api/settings/ai', async (req) => {
    const b = (req.body ?? {}) as { preference?: string; model?: string; cliModel?: string; claudeCliPath?: string | null };
    if (b.preference && ['auto', 'gemini', 'anthropic', 'claude-cli'].includes(b.preference)) setSetting('ai.provider', b.preference);
    if (b.model && /^claude-[a-z0-9-]+$/.test(b.model)) setSetting('ai.model', b.model);
    if (b.cliModel && /^[a-z0-9.-]+$/i.test(b.cliModel)) setSetting('ai.cliModel', b.cliModel);
    if (b.claudeCliPath !== undefined) setSetting('ai.claudeCliPath', b.claudeCliPath || null);
    return { ok: true };
  });

  // A chave é recebida e gravada apenas no servidor; nunca é devolvida à interface.
  app.put('/api/settings/ai/key', async (req) => {
    const { key } = (req.body ?? {}) as { key?: string | null };
    if (key && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim())) throw badRequest('Esse não parece ser uma chave válida da Anthropic.', 'A chave começa com "sk-ant-". Copie-a novamente do console da Anthropic.');
    setSecret('ANTHROPIC_API_KEY', key ? key.trim() : null);
    return { ok: true };
  });

  app.put('/api/settings/ai/gemini-key', async (req) => {
    const { key } = (req.body ?? {}) as { key?: string | null };
    if (key && !/^AIza[0-9A-Za-z_-]{30,}$/.test(key.trim())) throw badRequest('Essa não é uma chave do Gemini.', key.trim().startsWith('GOCSPX') ? 'Isso é a chave secreta do Google Drive. A chave do Gemini começa com "AIza": copie em aistudio.google.com → Chaves de API.' : 'A chave do Gemini começa com "AIza". Copie em aistudio.google.com → Chaves de API.');
    setSecret('GEMINI_API_KEY', key ? key.trim() : null);
    return { ok: true };
  });

  app.post('/api/settings/ai/test', async (req) => {
    const { provider } = (req.body ?? {}) as { provider?: ProviderId };
    try {
      const r = await generateJson<{ ok: string }>(
        { system: 'Responda somente no formato pedido.', prompt: 'Responda com ok = "funcionando".', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'string' } } }, maxTokens: 2000 },
        provider,
      );
      return { ok: true, provider: r.provider, model: r.model, answer: r.data.ok };
    } catch (e) {
      if (e instanceof AiError) return { ok: false, error: e.message, hint: e.hint };
      return { ok: false, error: String((e as Error).message), hint: '' };
    }
  });

  app.get('/api/settings/theme', async () => getSetting('theme', null));
  app.put('/api/settings/theme', async (req) => {
    const t = req.body as Record<string, string> | null;
    if (t && Object.values(t).some((v) => typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v))) throw badRequest('Cores inválidas.', 'Use cores no formato #RRGGBB.');
    setSetting('theme', t);
    return { ok: true };
  });

  app.get('/api/system', async () => {
    let ffmpeg = 'não encontrado';
    try {
      ffmpeg = (await runCapture(config.ffmpeg, ['-version'])).toString().split('\n')[0];
    } catch {
      /* FFmpeg ausente */
    }
    return { ffmpeg, encoders: await availableEncoders(), dataDir: config.dataDir, node: process.version };
  });
}
