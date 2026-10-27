// Estúdio: vários Reels a partir de uma entrevista e ritmo de edição a partir de um vídeo de referência.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { db, getSetting, now, setSetting } from '../db.ts';
import { config } from '../config.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { assetPath } from '../lib/storage.ts';
import { rowToAsset, rowToBrand } from '../lib/mappers.ts';
import { DEFAULT_CAPTION_STYLE, defaultCaptionY, emptyTimeline, uid } from '../../../shared/timeline.ts';
import { hookRange, rhythmFromCuts, sanitizePicks, sentenceRange, splitSentences, VIRAL_CAPTION, type ReelPick, type RhythmProfile } from '../../../shared/studio.ts';
import { enqueue } from '../jobs/queue.ts';
import { availableEncoders } from '../lib/ffmpeg.ts';
import { applyAction, type ActionContext, type EditAction } from '../../../shared/edit-actions.ts';
import type { Asset, CaptionWord, Timeline } from '../../../shared/types.ts';
import { generateJson, AiError } from '../ai/providers.ts';
import { brandContext } from '../ai/copy.ts';

function assetRow(id: string) {
  const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Arquivo');
  return r;
}

function wordsOf(assetId: string): CaptionWord[] | null {
  const t = db.prepare('SELECT words FROM transcripts WHERE asset_id = ?').get(assetId) as any;
  return t ? JSON.parse(t.words) : null;
}

const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'note'],
  properties: {
    note: { type: 'string', description: 'Observação curta sobre o material (ex.: pouco conteúdo aproveitável)' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'title', 'hook', 'why'],
        properties: {
          from: { type: 'integer', description: 'Índice da primeira frase' },
          to: { type: 'integer', description: 'Índice da última frase (inclusive)' },
          title: { type: 'string', description: 'Nome interno do corte' },
          hook: { type: 'string', description: 'Título curto para a tela nos 3 primeiros segundos, fiel ao que é dito (até 8 palavras)' },
          why: { type: 'string', description: 'Por que este trecho funciona sozinho' },
          hookSentence: { type: 'integer', description: 'Modo viral: índice da frase MAIS forte dentro do trecho para abrir o vídeo (teaser), ou -1' },
          score: { type: 'integer', description: 'Modo viral: potencial de retenção 0-100' },
          structure: { type: 'object', additionalProperties: false, required: ['inicio', 'meio', 'fim'], properties: { inicio: { type: 'string' }, meio: { type: 'string' }, fim: { type: 'string' } } },
        },
      },
    },
  },
};

/** Mede os cortes de câmera pela detecção de mudança de cena do FFmpeg. */
function sceneCuts(file: string, threshold = 0.3): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-hide_banner', '-i', file, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.split('\n').slice(-3).join(' ')));
      resolve([...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])));
    });
  });
}

export async function studioRoutes(app: FastifyInstance) {
  // ---- Reels a partir de uma entrevista ----
  app.post('/api/assets/:id/reels/suggest', async (req) => {
    const a = assetRow((req.params as any).id);
    const b = (req.body ?? {}) as { count?: number; minDur?: number; maxDur?: number; notes?: string; viral?: boolean };
    const words = wordsOf(a.id);
    if (!words?.length) throw new AppError(409, 'Este vídeo ainda não foi transcrito.', 'Clique em "Transcrever" e aguarde; os cortes são escolhidos pela fala.');
    const meta = JSON.parse(a.meta);
    const count = Math.max(1, Math.min(6, Math.round(Number(b.count) || 3)));
    const minDur = Math.max(10, Number(b.minDur) || 20);
    const maxDur = Math.max(minDur + 5, Math.min(180, Number(b.maxDur) || 60));
    const sents = splitSentences(words);
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(a.brand_id));
    try {
      const r = await generateJson<{ segments: ReelPick[]; note: string }>({
        system: `Você é editor de cortes de entrevistas/podcasts para Reels e TikTok de uma agência brasileira.
Escolha trechos que funcionem SOZINHOS: começam com uma frase que prende (pergunta, afirmação forte, número, conflito), desenvolvem uma ideia completa e terminam com conclusão — sem depender de contexto anterior.
${b.viral ? `MODO VIRAL (podcast/entrevista longa):
- Os 3 primeiros segundos decidem: o trecho precisa ABRIR com tensão (pergunta provocativa, afirmação contraintuitiva, número, erro comum, história pessoal forte). Nada de "bom dia", "então", contexto ou apresentação.
- Estrutura obrigatória: INÍCIO (gancho) → MEIO (explica/conta/prova) → FIM (conclusão, lição ou frase de efeito que fecha a ideia). Proibido terminar no meio do raciocínio ou com "e aí…".
- hookSentence: se houver, DENTRO do trecho, uma frase curta ainda mais forte que a primeira (até ~6 s), indique o índice dela para virar teaser de abertura; senão -1.
- score: retenção estimada 0-100 (gancho, clareza, emoção, utilidade, frase final). Ordene do maior para o menor.
- Prefira temas universais e úteis (dinheiro, carreira, negócios, relacionamentos, erros, segredos), que geram compartilhamento e salvamento.
` : ''}Regras: use os índices das frases fornecidas (from/to inclusive); nunca escolha trechos sobrepostos; respeite a duração pedida; não invente nada no título — ele precisa ser fiel ao que a pessoa diz. Prefira os trechos mais fortes primeiro. Se não houver ${count} bons trechos, devolva menos e explique em "note".`,
        prompt: `${brandContext(brand.name, brand.profile).text}
# Vídeo "${a.name}" (${Math.round(meta.duration ?? 0)} s)
Quero ${count} cortes, cada um entre ${minDur} e ${maxDur} segundos.${b.notes ? `\nPedido do editor: ${String(b.notes).slice(0, 500)}` : ''}
# Frases (índice, início–fim em segundos, texto)
${sents.map((s) => `[${s.i}] ${s.s.toFixed(1)}–${s.e.toFixed(1)} ${s.text}`).join('\n').slice(0, 60000)}`,
        schema: PICK_SCHEMA,
        maxTokens: 6000,
      });
      const picks = sanitizePicks(r.data.segments ?? [], sents, minDur, maxDur).slice(0, count);
      return {
        note: r.data.note,
        model: r.model,
        segments: picks.map((p) => {
          const hr = b.viral ? hookRange(p, sents, meta.duration ?? p.end + 1) : null;
          return { ...p, ...sentenceRange(sents, p.from, p.to, meta.duration ?? p.end + 1), hookIn: hr?.in ?? null, hookOut: hr?.out ?? null, hookText: hr ? sents[Number(p.hookSentence)].text : null, text: sents.slice(p.from, p.to + 1).map((s) => s.text).join(' ') };
        }).sort((x, y) => (y.score ?? 0) - (x.score ?? 0)),
      };
    } catch (e) {
      if (e instanceof AiError) throw new AppError(503, e.message, e.hint);
      throw e;
    }
  });

  app.post('/api/assets/:id/reels/create', async (req) => {
    const a = assetRow((req.params as any).id);
    const b = (req.body ?? {}) as { segments: { in: number; out: number; title: string; hook: string; hookIn?: number | null; hookOut?: number | null }[]; captions?: boolean; logo?: boolean; hookTitle?: boolean; removePauses?: boolean; viral?: boolean; autoExport?: boolean };
    if (!b.segments?.length) throw badRequest('Escolha ao menos um corte.');
    const meta = JSON.parse(a.meta);
    const words = wordsOf(a.id) ?? [];
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(a.brand_id));
    const assets: Record<string, Asset> = { [a.id]: rowToAsset(a) };
    if (brand.profile.logoAssetId) {
      const lr = db.prepare('SELECT * FROM assets WHERE id = ? AND brand_id = ?').get(brand.profile.logoAssetId, brand.id) as any;
      if (lr) assets[lr.id] = rowToAsset(lr);
    }
    const ctx: ActionContext = { transcripts: { [a.id]: words }, assets, brand: { colors: brand.profile.colors.map((c) => c.hex), logoAssetId: brand.profile.logoAssetId, font: undefined } };
    const created: { id: string; name: string; warnings: string[]; jobId: string | null }[] = [];
    // Exportação automática: usa a aceleração de hardware se uma codificação de teste funcionar.
    const encs = b.autoExport ? await availableEncoders() : [];
    const encoder = encs.includes('h264_qsv') ? 'h264_qsv' : encs.includes('h264_nvenc') ? 'h264_nvenc' : 'libx264';
    b.segments.slice(0, 6).forEach((s, k) => {
      const inn = Math.max(0, Number(s.in) || 0);
      const out = Math.min(meta.duration ?? Infinity, Number(s.out) || 0);
      if (out - inn < 3) return;
      let tl: Timeline = emptyTimeline('9:16');
      tl.captions.style = { ...DEFAULT_CAPTION_STYLE, ...(brand.profile.captionStyle ?? {}), posY: defaultCaptionY(tl.format) };
      if (!brand.profile.captionStyle && brand.profile.colors[0]) tl.captions.style.highlightColor = brand.profile.colors[0].hex;
      const base = { assetId: a.id, speed: 1, volume: 1, fit: 'cover' as const, focusX: 0.5, focusY: 0.5 };
      tl.clips = [{ id: uid('c_'), ...base, in: inn, out }];
      if (b.viral) {
        tl.captions.style = { ...tl.captions.style, ...VIRAL_CAPTION };
        // Abertura com a frase mais forte (teaser) e corte com flash para o trecho completo.
        const hi = Number(s.hookIn), ho = Number(s.hookOut);
        if (Number.isFinite(hi) && Number.isFinite(ho) && ho - hi >= 1 && ho - hi <= 8) {
          tl.clips = [{ id: uid('c_'), ...base, in: hi, out: ho, zoom: { from: 1.12, to: 1.18 } }, { ...tl.clips[0], transition: { type: 'flash', duration: 0.3 } }];
        }
      }
      const steps: EditAction[] = [];
      if (b.removePauses !== false && words.length) steps.push({ type: 'remove_pauses' });
      if (b.captions !== false && words.length) steps.push({ type: 'captions' });
      if (b.logo !== false && brand.profile.logoAssetId && assets[brand.profile.logoAssetId]) steps.push({ type: 'logo' });
      if (b.hookTitle !== false && s.hook?.trim()) steps.push({ type: 'text', text: s.hook.trim(), start: 0, duration: 3, kind: 'title', anim: 'pop' });
      if (b.viral) steps.push({ type: 'filter', preset: 'cinema' }, { type: 'rhythm', shotLength: 2.6 }, { type: 'denoise', level: 'light' });
      const warnings: string[] = [];
      for (const st of steps) {
        try {
          tl = applyAction(tl, st, ctx).timeline;
        } catch (e) {
          warnings.push((e as Error).message);
        }
      }
      const id = uid('p_');
      const name = `${(s.title || `Corte ${k + 1}`).slice(0, 80)} — ${a.name.replace(/\.[^.]+$/, '')}`;
      db.prepare("INSERT INTO projects (id, brand_id, name, status, timeline, revision, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, 0, ?, ?)").run(id, a.brand_id, name, JSON.stringify(tl), now(), now());
      let jobId: string | null = null;
      if (b.autoExport) {
        const settings = { width: tl.format.width, height: tl.format.height, fps: tl.format.fps, quality: 'high' as const, encoder: encoder as any };
        jobId = enqueue({ type: 'render', title: `Exportando "${name}" (${settings.width}x${settings.height})`, brandId: a.brand_id, projectId: id, payload: { projectId: id, timeline: tl, settings, revision: 0, name } });
      }
      created.push({ id, name, warnings, jobId });
    });
    return { created };
  });

  // ---- Ritmo de um vídeo de referência ----
  app.post('/api/assets/:id/rhythm', async (req) => {
    const a = assetRow((req.params as any).id);
    if (a.kind !== 'video' || a.status !== 'ready') throw badRequest('Escolha um vídeo já preparado na Biblioteca.');
    const meta = JSON.parse(a.meta);
    const proxy = assetPath(a.brand_id, a.id, 'proxy');
    const file = fs.existsSync(proxy) ? proxy : assetPath(a.brand_id, a.id, 'original', a.ext);
    let cuts: number[];
    try {
      cuts = await sceneCuts(file);
    } catch (e) {
      throw new AppError(500, 'Não foi possível medir os cortes deste vídeo.', `Detalhe do FFmpeg: ${(e as Error).message}`);
    }
    const words = wordsOf(a.id);
    const profile: RhythmProfile = rhythmFromCuts(meta.duration ?? 0, cuts, words?.length && meta.duration ? (words.length / meta.duration) * 60 : null);
    const saved = { assetId: a.id, name: a.name, measuredAt: now(), method: 'Detecção de mudança de cena do FFmpeg (limiar 0,3)', ...profile };
    setSetting(`rhythm.${a.id}`, saved);
    return saved;
  });

  app.get('/api/brands/:id/rhythms', async (req) => {
    const ids = (db.prepare("SELECT id FROM assets WHERE brand_id = ? AND kind = 'video'").all((req.params as any).id) as any[]).map((r) => r.id);
    return ids.map((id) => getSetting<any>(`rhythm.${id}`, null)).filter(Boolean);
  });
}
