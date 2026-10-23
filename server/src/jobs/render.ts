import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { assetPath, exportPath, jobTmp, rmrf, safeFileName } from '../lib/storage.ts';
import { resolveFontFiles } from '../lib/fonts.ts';
import { buildAss } from '../../../shared/ass.ts';
import { uid } from '../../../shared/timeline.ts';
import type { Timeline } from '../../../shared/types.ts';
import { buildRenderArgs, type RenderSettings } from './render-graph.ts';
import type { JobContext } from './queue.ts';

export async function renderHandler(ctx: JobContext) {
  const { projectId, timeline, settings, revision, name } = ctx.payload as { projectId: string; timeline: Timeline; settings: RenderSettings; revision: number; name: string };
  const project = db.prepare('SELECT id, brand_id FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) throw new Error('O projeto foi excluído antes da exportação.');

  const ids = new Set([...timeline.clips.map((c) => c.assetId), ...timeline.overlays.map((o) => o.assetId), ...(timeline.music ? [timeline.music.assetId] : [])]);
  const assets: Record<string, { file: string; meta: any }> = {};
  for (const id of ids) {
    const a = db.prepare('SELECT * FROM assets WHERE id = ? AND brand_id = ?').get(id, project.brand_id) as any;
    if (!a) throw new Error('Um arquivo usado no projeto não pertence a esta marca ou foi excluído.');
    const file = assetPath(a.brand_id, a.id, 'original', a.ext);
    if (!fs.existsSync(file)) throw new Error(`O arquivo original "${a.name}" não foi encontrado no armazenamento.`);
    assets[id] = { file, meta: JSON.parse(a.meta) };
  }

  const work = jobTmp(ctx.job.id);
  try {
    let assFile: string | null = null;
    let fontsDir: string | null = null;
    if ((timeline.captions.enabled && timeline.captions.cues.length) || timeline.texts?.length) {
      fs.writeFileSync(path.join(work, 'captions.ass'), buildAss(timeline), 'utf8');
      assFile = 'captions.ass';
      const families = new Set([timeline.captions.style.font, ...(timeline.texts ?? []).map((t) => t.font)]);
      const fonts = [...families].flatMap((fam) => [...resolveFontFiles(fam, fam === timeline.captions.style.font && timeline.captions.style.bold, project.brand_id), ...resolveFontFiles(fam, true, project.brand_id)]);
      if (fonts.length) {
        fs.mkdirSync(path.join(work, 'fonts'), { recursive: true });
        for (const ft of fonts) fs.copyFileSync(ft.file, path.join(work, 'fonts', path.basename(ft.file)));
        fontsDir = 'fonts';
      }
    }
    const tmpOut = path.join(work, 'out.mp4');
    const { args, duration } = buildRenderArgs(timeline, settings, { assets, assFile, fontsDir, output: 'out.mp4' });
    fs.writeFileSync(path.join(work, 'command.txt'), args.join(' '), 'utf8');
    ctx.progress(0.01, 'Renderizando');
    await runFfmpeg(args, {
      cwd: work,
      duration,
      signal: ctx.signal,
      onProgress: (fr, info) => ctx.progress(0.01 + fr * 0.97, `Renderizando ${Math.round(fr * 100)}%${info.speed ? ` (${info.speed})` : ''}`),
    });
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1000) throw new Error('O FFmpeg terminou, mas o arquivo final não foi gerado corretamente.');

    const exportId = uid('e_');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const file = `${safeFileName(name)}-${settings.width}x${settings.height}-${stamp}.mp4`;
    const dest = exportPath(project.brand_id, file);
    fs.copyFileSync(tmpOut, dest);
    const size = fs.statSync(dest).size;
    db.prepare('INSERT INTO exports (id, project_id, brand_id, job_id, file, size, settings, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      exportId, projectId, project.brand_id, ctx.job.id, file, size, JSON.stringify(settings), revision, now(),
    );
    return { exportId, file, size, duration };
  } finally {
    rmrf(work);
  }
}
