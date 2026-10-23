// Teste ponta a ponta do fluxo da Etapa 1 contra um servidor rodando com dados de teste.
// Uso:
//   ORBIT_DATA_DIR=data-test node server/src/index.ts      (em outro terminal)
//   node tests/e2e-flow.ts <video> <logo.png>
// A senha de teste é gerada e guardada em data-test/.test-credentials.json (fora do git).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildCues } from '../shared/captions.ts';
import { layoutClips, splitAt, rippleDelete, uid } from '../shared/timeline.ts';
import type { Timeline } from '../shared/types.ts';

const BASE = process.env.ORBIT_URL ?? 'http://127.0.0.1:4310';
const [video, logo] = process.argv.slice(2);
if (!video || !logo) throw new Error('Informe o vídeo e o logo.');
const credFile = path.resolve('data-test/.test-credentials.json');
let cookie = '';

async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data?.error} ${data?.hint ?? ''}`);
  return data as T;
}

async function waitJob(id: string, label: string) {
  let last = '';
  for (;;) {
    const jobs = await api<any[]>('GET', `/api/jobs?limit=200`);
    const j = jobs.find((x) => x.id === id);
    if (!j) throw new Error('Trabalho sumiu: ' + id);
    const line = `${label}: ${Math.round(j.progress * 100)}% ${j.message}`;
    if (line !== last) console.log('  ', line);
    last = line;
    if (j.status === 'done') return j;
    if (j.status === 'failed' || j.status === 'canceled') throw new Error(`${label} falhou: ${j.error}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const t0 = Date.now();
const status = await api('GET', '/api/auth/status');
if (!status.setupDone) {
  const password = crypto.randomBytes(12).toString('base64url');
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ password }));
  await api('POST', '/api/auth/setup', { password });
} else {
  await api('POST', '/api/auth/login', JSON.parse(fs.readFileSync(credFile, 'utf8')));
}
console.log('1. Sessão autenticada');

const brand = await api('POST', '/api/brands', { name: `Teste E2E ${new Date().toISOString().slice(11, 19)}`, profile: { colors: [{ name: 'Laranja', hex: '#FF7A00' }] } });
console.log('2. Marca criada:', brand.name, '| campos a preencher:', brand.missing.join(', '));

const v = await api('POST', `/api/brands/${brand.id}/assets/import-path`, { filePath: video });
const l = await api('POST', `/api/brands/${brand.id}/assets/import-path`, { filePath: logo });
const dup = await api('POST', `/api/brands/${brand.id}/assets/import-path`, { filePath: video });
console.log('3. Importados. Duplicado detectado na 2ª importação:', dup.duplicate);
const jobs = await api<any[]>('GET', `/api/jobs?brandId=${brand.id}`);
for (const j of jobs.filter((x) => x.type === 'ingest')) await waitJob(j.id, 'preparação');
const asset = await api('GET', `/api/assets/${v.asset.id}`);
console.log('   meta:', JSON.stringify(asset.meta));

await api('PUT', `/api/brands/${brand.id}`, { profile: { logoAssetId: l.asset.id } });

const project = await api('POST', '/api/projects', { brandId: brand.id, name: 'Reels teste E2E', preset: '9:16', assetIds: [asset.id] });
console.log('4. Projeto criado, duração', project.duration.toFixed(2), 's');

const tr = await api('POST', `/api/assets/${asset.id}/transcribe`, { model: process.env.ASR_MODEL ?? 'Xenova/whisper-small' });
await waitJob(tr.jobId, 'transcrição');
const transcript = await api('GET', `/api/assets/${asset.id}/transcript`);
console.log('5. Transcrição:', transcript.words.length, 'palavras —', transcript.text.slice(0, 120) + '…');

// Edição: mantém só os primeiros 20 s, remove 2 s do meio, gera legendas e aplica o logo.
let tl: Timeline = project.timeline;
tl = splitAt(tl, 20).timeline;
tl = { ...tl, clips: tl.clips.slice(0, 1) };
tl = rippleDelete(tl, 8, 10);
tl.captions.cues = buildCues(asset.id, transcript.words, tl.captions.style);
tl.overlays = [{ id: uid('o_'), assetId: l.asset.id, start: 0, end: 18, x: 0.84, y: 0.09, width: 0.22, opacity: 0.95 }];
const placed = layoutClips(tl.clips);
console.log('6. Timeline:', placed.map((p) => `[${p.clip.in.toFixed(1)}–${p.clip.out.toFixed(1)}]`).join(' '), '| legendas:', tl.captions.cues.length);
const saved = await api('PUT', `/api/projects/${project.id}`, { timeline: tl, baseRevision: 0 });
console.log('   salvo, revisão', saved.revision);

const ex = await api('POST', `/api/projects/${project.id}/export`, { quality: 'high' });
const done = await waitJob(ex.jobId, 'exportação');
console.log('7. Exportado:', done.result.file, (done.result.size / 1e6).toFixed(1), 'MB, duração esperada', done.result.duration.toFixed(2), 's');
fs.writeFileSync(path.resolve('data-test/last-e2e.json'), JSON.stringify({ brandId: brand.id, projectId: project.id, exportId: done.result.exportId, file: done.result.file }, null, 2));

try {
  const copy = await api('POST', `/api/projects/${project.id}/post-copy`, { network: 'instagram', objective: '', variations: 1 });
  console.log('8. Texto do post gerado por', copy.model, '\n', copy.content.variations[0]?.fullText);
} catch (e) {
  console.log('8. Texto do post não gerado (depende de configuração de IA):', (e as Error).message);
}
console.log(`Fluxo completo em ${((Date.now() - t0) / 1000).toFixed(0)} s`);
