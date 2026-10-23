// GDR Digital — servidor local.
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import './lib/crashlog.ts';
import './db.ts';
import { AppError } from './lib/errors.ts';
import { authRoutes, isAuthenticated } from './routes/auth.ts';
import { brandRoutes } from './routes/brands.ts';
import { assetRoutes } from './routes/assets.ts';
import { projectRoutes } from './routes/projects.ts';
import { systemRoutes } from './routes/system.ts';
import { registerJob, startQueue } from './jobs/queue.ts';
import { ingestHandler } from './jobs/ingest.ts';
import { transcribeHandler } from './jobs/transcribe.ts';
import { renderHandler } from './jobs/render.ts';
import { socialRoutes, publishHandler, startScheduler } from './social/routes.ts';
import { driveRoutes, driveImportHandler, startDriveWatcher } from './drive.ts';
import { resultsRoutes } from './social/results-routes.ts';
import { metricsHandler } from './social/insights.ts';
import { inboxRoutes } from './social/inbox-routes.ts';
import { intelligenceRoutes } from './social/intelligence.ts';
import { studioRoutes } from './routes/studio.ts';
import { startInbox } from './social/inbox.ts';

const app = Fastify({
  trustProxy: true,
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 20 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

// Todas as rotas da API exigem sessão, exceto as de autenticação.
app.addHook('onRequest', async (req) => {
  if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url.startsWith('/api/social/meta/callback') || req.url.startsWith('/api/drive/callback')) return;
  if (!isAuthenticated(req)) throw new AppError(401, 'Sua sessão expirou.', 'Entre novamente com sua senha.', 'nao_autenticado');
});

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, hint: err.hint, code: err.code });
  if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'Arquivo grande demais.', hint: 'O limite é de 20 GB por arquivo.' });
  if (err.validation) return reply.code(400).send({ error: 'Dados inválidos na requisição.', hint: err.message });
  req.log.error(err);
  console.error('[erro]', req.method, req.url, err?.message);
  reply.code(500).send({ error: 'Erro interno no servidor.', hint: 'Tente novamente. Se persistir, veja o terminal onde o GDR Digital está rodando.' });
});

await app.register(authRoutes);
await app.register(brandRoutes);
await app.register(assetRoutes);
await app.register(projectRoutes);
await app.register(systemRoutes);
await app.register(socialRoutes);
await app.register(driveRoutes);
await app.register(resultsRoutes);
await app.register(inboxRoutes);
await app.register(intelligenceRoutes);
await app.register(studioRoutes);

// Interface compilada (produção). Em desenvolvimento o Vite serve a interface.
if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
  // wildcard (padrão): serve arquivos novos após recompilar a interface sem reiniciar o servidor
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Rota não encontrada.', hint: '' });
    return reply.sendFile('index.html');
  });
}

registerJob('ingest', ingestHandler, 2);
registerJob('transcribe', transcribeHandler, 1);
registerJob('render', renderHandler, 1);
registerJob('publish', publishHandler, 1);
registerJob('drive', driveImportHandler, 1);
registerJob('metrics', metricsHandler, 1);
startQueue();
startScheduler();
startDriveWatcher();
startInbox();

await app.listen({ host: config.host, port: config.port });
console.log(`\n  GDR Digital rodando em http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
console.log(`  Dados em ${config.dataDir}\n`);
