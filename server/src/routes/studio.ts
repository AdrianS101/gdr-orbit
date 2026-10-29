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
import { ANIMATED_CAPTION, hookRange, markKeywords, PODCAST_CAPTION, rhythmFromCuts, sanitizePicks, sentenceRange, splitSentences, VIRAL_CAPTION, type ReelPick, type RhythmProfile } from '../../../shared/studio.ts';
import { enqueue } from '../jobs/queue.ts';
import { exposureCorrection, measureExposure } from '../lib/exposure.ts';
import { autoReframe, type ReframeTarget } from '../lib/reframe.ts';
import { colorFromPreset } from '../../../shared/effects.ts';
import { availableEncoders } from '../lib/ffmpeg.ts';
import { applyAction, type ActionContext, type EditAction } from '../../../shared/edit-actions.ts';
import type { Asset, CaptionWord, Timeline } from '../../../shared/types.ts';
import { generateJson, AiError } from '../ai/providers.ts';
import { brandContext } from '../ai/copy.ts';

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

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
          keywords: { type: 'array', items: { type: 'string' }, description: 'Palavras do trecho para destacar na legenda' },
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
    const b = (req.body ?? {}) as { count?: number | 'auto'; minDur?: number; maxDur?: number; length?: 'auto' | 'lt30' | '30-60' | '60-90' | '90-180'; notes?: string; topics?: string; moments?: string; viral?: boolean };
    const words = wordsOf(a.id);
    if (!words?.length) throw new AppError(409, 'Este vídeo ainda não foi transcrito.', 'Clique em "Transcrever" e aguarde; os cortes são escolhidos pela fala.');
    const meta = JSON.parse(a.meta);
    // Quantidade automática: a IA lê a conversa inteira e devolve todos os trechos realmente bons.
    const auto = b.count === 'auto' || b.count === undefined;
    const count = auto ? 20 : Math.max(1, Math.min(20, Math.round(Number(b.count) || 3)));
    const LEN: Record<string, [number, number]> = { auto: [15, 90], lt30: [12, 30], '30-60': [30, 60], '60-90': [60, 90], '90-180': [90, 180] };
    const [minDur, maxDur] = b.length ? LEN[b.length] ?? LEN.auto : [Math.max(10, Number(b.minDur) || 20), Math.max((Number(b.minDur) || 20) + 5, Math.min(180, Number(b.maxDur) || 60))];
    const sents = splitSentences(words);
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(a.brand_id));
    try {
      // Conversas longas são lidas em janelas (~22 mil caracteres, com sobreposição, até 6 ao mesmo tempo), e os melhores trechos de
      // todas as janelas são unidos e ranqueados — assim um podcast de 1h+ é lido inteiro.
      const lines = sents.map((q) => `[${q.i}] ${q.s.toFixed(1)}–${q.e.toFixed(1)} ${q.text}`);
      const windows: [number, number][] = [];
      for (let i = 0; i < lines.length; ) {
        let j = i, size = 0;
        while (j < lines.length && size + lines[j].length < 22000) size += lines[j++].length + 1;
        j = Math.max(j, i + 1);
        windows.push([i, j]);
        if (j >= lines.length) break;
        i = Math.max(i + 1, j - 12); // 12 frases de sobreposição para não partir uma história no meio
      }
      const perWindow = auto ? 5 : Math.min(count, Math.ceil(count / windows.length) + 2);
      const all: ReelPick[] = [];
      const notes: string[] = [];
      let model = '';
      const readWindow = async (wi: number) => {
        const [i0, i1] = windows[wi];
        const part = windows.length > 1 ? `\n(Parte ${wi + 1} de ${windows.length} da conversa: ${mmss(sents[i0].s)}–${mmss(sents[i1 - 1].e)}. Escolha só trechos desta parte; até ${perWindow}.)` : '';
      const r = await generateJson<{ segments: ReelPick[]; note: string }>({
        system: `Você é editor de cortes de entrevistas/podcasts para Reels e TikTok de uma agência brasileira.
Escolha trechos que funcionem SOZINHOS: começam com uma frase que prende (pergunta, afirmação forte, número, conflito), desenvolvem uma ideia completa e terminam com conclusão — sem depender de contexto anterior.
${b.viral ? `MODO VIRAL (podcast/entrevista longa):
- Os 3 primeiros segundos decidem: o trecho precisa ABRIR com tensão (pergunta provocativa, afirmação contraintuitiva, número, erro comum, história pessoal forte). Nada de "bom dia", "então", contexto ou apresentação.
- Estrutura obrigatória: INÍCIO (gancho) → MEIO (explica/conta/prova) → FIM (conclusão, lição ou frase de efeito que fecha a ideia). Proibido terminar no meio do raciocínio ou com "e aí…".
- hookSentence: se houver, DENTRO do trecho, uma frase curta ainda mais forte que a primeira (até ~6 s), indique o índice dela para virar teaser de abertura; senão -1.
- score: retenção estimada 0-100 (gancho, clareza, emoção, utilidade, frase final). Ordene do maior para o menor.
- Prefira temas universais e úteis (dinheiro, carreira, negócios, relacionamentos, erros, segredos), que geram compartilhamento e salvamento.
` : ''}Regras: use os índices das frases fornecidas (from/to inclusive); nunca escolha trechos sobrepostos; respeite a duração pedida; não invente nada no título — ele precisa ser fiel ao que a pessoa diz. Prefira os trechos mais fortes primeiro. ${auto ? 'QUANTIDADE AUTOMÁTICA: leia a transcrição INTEIRA e devolva TODOS os trechos que realmente funcionam sozinhos (nota ≥ 60), do melhor para o pior, no máximo 15. Não complete com trechos fracos.' : `Se não houver ${count} bons trechos, devolva menos e explique em "note".`}
keywords: 2 a 6 palavras do próprio trecho que carregam a ideia (nomes, números, verbos fortes) — serão destacadas na legenda.
Se o editor pedir MOMENTOS EXATOS (ex.: "02:10 a 03:00") ou assuntos, gere esses cortes primeiro, ajustando o início e o fim para frases completas.`,
        prompt: `${brandContext(brand.name, brand.profile).text}
# Vídeo "${a.name}" (${Math.round(meta.duration ?? 0)} s)
${auto ? 'Quantidade: automática (todos os bons)' : `Quero ${count} cortes`}, cada um entre ${minDur} e ${maxDur} segundos.${b.notes ? `\nPedido do editor: ${String(b.notes).slice(0, 500)}` : ''}${b.topics ? `\nAssuntos que devem aparecer: ${String(b.topics).slice(0, 300)}` : ''}${b.moments ? `\nMomentos/instruções do editor (prioridade): ${String(b.moments).slice(0, 1500)}` : ''}
# Frases (índice, início–fim em segundos, texto)
${lines.slice(i0, i1).join('\n')}${part}`,
        schema: PICK_SCHEMA,
        maxTokens: 9000,
      });
        all.push(...(r.data.segments ?? []).filter((p) => p.from >= i0 && p.to < i1));
        if (r.data.note) notes.push(r.data.note);
        model = r.model;
      };
      // Até 6 partes ao mesmo tempo (cabe no limite gratuito do Gemini); uma parte que falhar não perde as outras.
      const errors: unknown[] = [];
      for (let w = 0; w < windows.length; w += 6) {
        const res = await Promise.allSettled(windows.slice(w, w + 6).map((_, k) => readWindow(w + k)));
        for (const x of res) if (x.status === 'rejected') errors.push(x.reason);
      }
      if (errors.length === windows.length) throw errors[0];
      if (errors.length) notes.unshift(`${errors.length} de ${windows.length} partes não puderam ser lidas agora (IA sobrecarregada); os cortes vêm das demais.`);
      // Une as janelas: melhores primeiro, sem sobreposição.
      all.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
      let picks = sanitizePicks(auto ? all.filter((p) => (p.score ?? 100) >= 55) : all, sents, minDur, maxDur).slice(0, count);
      // Intervalos escritos pelo editor ("02:10 a 03:00") viram cortes garantidos, ajustados para frases inteiras.
      for (const m of String(b.moments ?? '').matchAll(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|–|a|até|ate)\s*(\d{1,2}:\d{2}(?::\d{2})?)/gi)) {
        const sec = (t: string) => t.split(':').map(Number).reduce((n, x) => n * 60 + x, 0);
        const [x, y] = [sec(m[1]), sec(m[2])];
        if (!(y > x)) continue;
        const idx = sents.filter((q) => q.e > x && q.s < y).map((q) => q.i);
        if (!idx.length || picks.some((p) => !(idx[idx.length - 1] < p.from || idx[0] > p.to))) continue;
        picks.unshift({ from: idx[0], to: idx[idx.length - 1], start: sents[idx[0]].s, end: sents[idx[idx.length - 1]].e, title: `Corte pedido (${m[1]}–${m[2]})`, hook: '', why: 'Momento indicado por você.', score: 100, warning: null } as any);
      }
      return {
        note: [windows.length > 1 ? `Conversa longa lida inteira em ${windows.length} partes.` : '', ...notes.slice(0, 2)].filter(Boolean).join(' '),
        model,
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
    const b = (req.body ?? {}) as { segments: { in: number; out: number; title: string; hook: string; hookIn?: number | null; hookOut?: number | null; score?: number; keywords?: string[]; why?: string; text?: string; structure?: unknown }[]; captions?: boolean; logo?: boolean; hookTitle?: boolean; removePauses?: boolean; viral?: boolean; autoExport?: boolean; style?: 'impacto' | 'podcast' | 'animada'; format?: '9:16' | '1:1' | '16:9'; highlightKeywords?: boolean; autoLight?: boolean; autoReframe?: boolean; reframe?: ReframeTarget; hook?: boolean; filter?: string; motion?: 'auto' | 'none'; denoise?: boolean };
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
    const podcast = b.style === 'podcast';
    const animada = b.style === 'animada';
    // Luz automática: mede o vídeo uma vez (proxy) por corte e corrige brilho/contraste.
    const proxyFile = fs.existsSync(assetPath(a.brand_id, a.id, 'proxy')) ? assetPath(a.brand_id, a.id, 'proxy') : assetPath(a.brand_id, a.id, 'original', a.ext);
    const lights = b.autoLight === false ? [] : await Promise.all(b.segments.slice(0, 20).map((sg) => measureExposure(proxyFile, Number(sg.in) || 0, Math.max(1, (Number(sg.out) || 0) - (Number(sg.in) || 0)))));
    const handle = (db.prepare("SELECT username FROM social_accounts WHERE brand_id = ? AND network = 'instagram' AND username IS NOT NULL AND status != 'manual' LIMIT 1").get(a.brand_id) as any)?.username ?? null;
    const created: { id: string; name: string; warnings: string[]; jobId: string | null }[] = [];
    // Exportação automática: usa a aceleração de hardware se uma codificação de teste funcionar.
    const encs = b.autoExport ? await availableEncoders() : [];
    const encoder = encs.includes('h264_qsv') ? 'h264_qsv' : encs.includes('h264_nvenc') ? 'h264_nvenc' : 'libx264';
    const pending: { id: string; name: string; tl: Timeline; clipMeta: unknown; warnings: string[] }[] = [];
    b.segments.slice(0, 20).forEach((s, k) => {
      const inn = Math.max(0, Number(s.in) || 0);
      const out = Math.min(meta.duration ?? Infinity, Number(s.out) || 0);
      if (out - inn < 3) return;
      let tl: Timeline = emptyTimeline(b.format && ['9:16', '1:1', '16:9'].includes(b.format) ? b.format : '9:16');
      tl.captions.style = { ...DEFAULT_CAPTION_STYLE, ...(brand.profile.captionStyle ?? {}), posY: defaultCaptionY(tl.format) };
      if (!brand.profile.captionStyle && brand.profile.colors[0]) tl.captions.style.highlightColor = brand.profile.colors[0].hex;
      const base = { assetId: a.id, speed: 1, volume: 1, fit: 'cover' as const, focusX: 0.5, focusY: 0.5 };
      tl.clips = [{ id: uid('c_'), ...base, in: inn, out }];
      if (b.viral) {
        tl.captions.style = { ...tl.captions.style, ...(podcast ? PODCAST_CAPTION : animada ? ANIMATED_CAPTION : VIRAL_CAPTION) };
        // Abertura com a frase mais forte (teaser) e corte com flash para o trecho completo.
        const hi = Number(s.hookIn), ho = Number(s.hookOut);
        if (b.hook !== false && Number.isFinite(hi) && Number.isFinite(ho) && ho - hi >= 1 && ho - hi <= 8) {
          tl.clips = [{ id: uid('c_'), ...base, in: hi, out: ho, zoom: { from: 1.12, to: 1.18 } }, { ...tl.clips[0], transition: { type: 'flash', duration: 0.3 } }];
        }
      }
      const steps: EditAction[] = [];
      if (b.removePauses !== false && words.length) steps.push({ type: 'remove_pauses' });
      if (b.captions !== false && words.length) steps.push(podcast ? { type: 'captions', highlightColor: '#FFFFFF', uppercase: false } : animada ? { type: 'captions', highlightColor: ANIMATED_CAPTION.highlightColor, uppercase: true } : { type: 'captions' });
      if (b.logo !== false && brand.profile.logoAssetId && assets[brand.profile.logoAssetId]) steps.push({ type: 'logo' });
      if (b.hookTitle !== false && s.hook?.trim() && !podcast && !animada) steps.push({ type: 'text', text: s.hook.trim(), start: 0, duration: 3, kind: 'title', anim: 'pop' });
      // Personalização: filtro, movimento (ritmo de planos + zoom) e limpeza do áudio podem ser trocados ou desligados.
      const motion = b.motion !== 'none';
      if (b.viral) {
        const preset = b.filter && b.filter !== 'auto' ? b.filter : podcast ? 'podcast' : animada ? null : 'cinema';
        if (preset && preset !== 'none') steps.push({ type: 'filter', preset: preset as any });
        if (motion) steps.push({ type: 'rhythm', shotLength: podcast ? 6 : animada ? 3.2 : 2.6 });
        if (b.denoise !== false) steps.push({ type: 'denoise', level: 'light' });
      }
      const warnings: string[] = [];
      for (const st of steps) {
        try {
          tl = applyAction(tl, st, ctx).timeline;
        } catch (e) {
          warnings.push((e as Error).message);
        }
      }
      if (b.viral && podcast) {
        // Movimento de câmera lento (push-in) no lugar de cortes secos; alterna o enquadramento a cada plano.
        if (motion) tl.clips = tl.clips.map((c, i) => ({ ...c, zoom: i % 2 === 0 ? { from: 1, to: 1.06 } : { from: 1.12, to: 1.15 } }));
        if (handle) {
          const total = tl.clips.reduce((n, c) => n + (c.out - c.in) / c.speed, 0);
          tl.texts = [...(tl.texts ?? []), { id: uid('t_'), start: 0, end: total, text: '@' + handle.toUpperCase(), kind: 'caption', anim: 'none', x: 0.5, y: PODCAST_CAPTION.posY - 0.045, size: 1.9, color: '#D8D8D8', bg: '', font: PODCAST_CAPTION.font }];
        }
      }
      // Palavras-chave sempre destacadas na legenda.
      if (!motion) tl.clips = tl.clips.map((c) => ({ ...c, zoom: undefined }));
      if (b.highlightKeywords !== false && s.keywords?.length) tl.captions = { ...tl.captions, cues: markKeywords(tl.captions.cues, s.keywords) };
      // Luz automática (mesma conta de cor na prévia e na exportação).
      const lt = lights[k];
      if (lt) {
        const fix = exposureCorrection(lt);
        if (fix.brightness !== 1 || fix.contrast !== 1) {
          tl.clips = tl.clips.map((c) => {
            const col = c.color ?? colorFromPreset('none');
            return { ...c, color: { ...col, brightness: Number((col.brightness * fix.brightness).toFixed(3)), contrast: Number((col.contrast * fix.contrast).toFixed(3)), preset: col.preset === 'none' ? 'auto' : col.preset } };
          });
        }
      }
      const id = uid('p_');
      const name = `${(s.title || `Corte ${k + 1}`).slice(0, 80)} — ${a.name.replace(/\.[^.]+$/, '')}`;
      const clipMeta = { assetId: a.id, score: typeof s.score === 'number' ? s.score : null, title: s.title, hook: s.hook, why: s.why ?? null, text: s.text ?? null, in: inn, out, keywords: s.keywords ?? [], structure: s.structure ?? null, style: b.style ?? 'impacto', light: lt ? exposureCorrection(lt) : null };
      pending.push({ id, name, tl, clipMeta, warnings });
    });
    // Enquadramento automático: acha a pessoa em cada trecho e centraliza o recorte nela (um único carregamento do detector).
    let reframe: { found: number; total: number } | null = null;
    if (b.autoReframe !== false && pending.length && meta.width && meta.height) {
      const r = await autoReframe(proxyFile, { width: meta.width, height: meta.height }, pending.map((p) => p.tl), b.reframe ?? { mode: 'largest' });
      r.timelines.forEach((tl, i) => (pending[i].tl = tl));
      reframe = { found: r.found, total: r.total };
    }
    for (const p of pending) {
      const { id, name, tl, clipMeta, warnings } = p;
      db.prepare("INSERT INTO projects (id, brand_id, name, status, timeline, revision, created_at, updated_at, clip_meta) VALUES (?, ?, ?, 'draft', ?, 0, ?, ?, ?)").run(id, a.brand_id, name, JSON.stringify(tl), now(), now(), JSON.stringify(clipMeta));
      let jobId: string | null = null;
      if (b.autoExport) {
        const settings = { width: tl.format.width, height: tl.format.height, fps: tl.format.fps, quality: 'high' as const, encoder: encoder as any };
        jobId = enqueue({ type: 'render', title: `Exportando "${name}" (${settings.width}x${settings.height})`, brandId: a.brand_id, projectId: id, payload: { projectId: id, timeline: tl, settings, revision: 0, name } });
      }
      created.push({ id, name, warnings, jobId });
    }
    return { created, reframe };
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
