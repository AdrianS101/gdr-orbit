// Inteligência sobre os resultados: análise do perfil, perguntas aos dados, concorrentes e pautas.
// Os números vêm sempre da Meta; a IA só interpreta e deve citar a evidência e as limitações.
import type { FastifyInstance } from 'fastify';
import { db, getSetting, now, setSetting } from '../db.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { unseal } from '../lib/vault.ts';
import { rowToBrand } from '../lib/mappers.ts';
import { uid } from '../../../shared/timeline.ts';
import { generateJson, geminiResearch, AiError } from '../ai/providers.ts';
import { brandContext } from '../ai/copy.ts';
import { graphVersion, MetaError } from './meta.ts';
import { emptyTimeline } from '../../../shared/timeline.ts';
import { metaFetch } from './meta-guard.ts';

const G = () => `https://graph.facebook.com/${graphVersion()}`;
const asApp = (e: unknown) => (e instanceof MetaError ? new AppError(400, e.message, e.hint) : e instanceof AiError ? new AppError(503, e.message, e.hint) : e);

const median = (xs: number[]) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function igAccount(brandId: string, accountId?: string) {
  const a = (accountId
    ? db.prepare("SELECT * FROM social_accounts WHERE id = ? AND brand_id = ? AND network = 'instagram'").get(accountId, brandId)
    : db.prepare("SELECT * FROM social_accounts WHERE brand_id = ? AND network = 'instagram' AND token IS NOT NULL").get(brandId)) as any;
  if (!a) throw new AppError(400, 'Esta marca não tem um Instagram conectado.', 'Conecte em Marcas → Perfis sociais.');
  return a;
}

function mediaOf(accountId: string, sinceIso: string, untilIso: string) {
  return (db.prepare('SELECT * FROM media_items WHERE account_id = ? AND posted_at >= ? AND posted_at < ? ORDER BY posted_at DESC').all(accountId, sinceIso, untilIso) as any[]).map((m) => ({
    id: m.external_id, type: m.type, caption: (m.caption ?? '').slice(0, 220), permalink: m.permalink, postedAt: m.posted_at, metrics: JSON.parse(m.metrics) as Record<string, number>,
  }));
}

/** Estatísticas calculadas (não estimadas) a partir dos posts do período. */
export function computeStats(media: ReturnType<typeof mediaOf>, days: number) {
  const byType: Record<string, { n: number; views: number | null; reach: number | null; shares: number | null; saved: number | null }> = {};
  for (const t of Array.from(new Set(media.map((m) => m.type)))) {
    const ms = media.filter((m) => m.type === t);
    byType[t] = { n: ms.length, views: median(ms.map((m) => m.metrics.views)), reach: median(ms.map((m) => m.metrics.reach)), shares: median(ms.map((m) => m.metrics.shares)), saved: median(ms.map((m) => m.metrics.saved)) };
  }
  const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const byWeekday = WD.map((d, i) => {
    const ms = media.filter((m) => new Date(m.postedAt).getDay() === i);
    return { day: d, n: ms.length, views: median(ms.map((m) => m.metrics.views)) };
  });
  const slots = [['madrugada', 0, 6], ['manhã', 6, 12], ['tarde', 12, 18], ['noite', 18, 24]] as const;
  const byTime = slots.map(([l, a, b]) => {
    const ms = media.filter((m) => {
      const h = new Date(m.postedAt).getHours();
      return h >= a && h < b;
    });
    return { slot: l, n: ms.length, views: median(ms.map((m) => m.metrics.views)) };
  });
  return { posts: media.length, perWeek: Number(((media.length / Math.max(1, days)) * 7).toFixed(1)), medianViews: median(media.map((m) => m.metrics.views)), byType, byWeekday, byTime, enough: media.length >= 10 };
}

async function competitorData(acc: any, username: string) {
  const f = `business_discovery.username(${username}){username,name,biography,followers_count,media_count,media.limit(25){caption,like_count,comments_count,media_product_type,media_type,timestamp,permalink}}`;
  const r = await metaFetch(`${G()}/${acc.external_id}?fields=${encodeURIComponent(f)}&access_token=${unseal(acc.token)}`);
  const j: any = await r.json();
  if (j.error) throw new MetaError(j.error.code === 110 || /not found|não encontr/i.test(j.error.message) ? `Perfil @${username} não encontrado ou não é profissional.` : j.error.message);
  const b = j.business_discovery;
  const media = (b.media?.data ?? []).map((m: any) => ({
    type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'image',
    likes: m.like_count ?? 0, comments: m.comments_count ?? 0, postedAt: m.timestamp, permalink: m.permalink, caption: (m.caption ?? '').slice(0, 200),
  }));
  const eng = media.map((m: any) => ((m.likes + m.comments) / Math.max(1, b.followers_count)) * 100);
  const span = media.length > 1 ? (Date.parse(media[0].postedAt) - Date.parse(media[media.length - 1].postedAt)) / 86400_000 : 0;
  const byType: Record<string, { n: number; engagement: number | null }> = {};
  for (const t of Array.from(new Set(media.map((m: any) => m.type))) as string[]) {
    const idx = media.map((m: any, i: number) => (m.type === t ? i : -1)).filter((i: number) => i >= 0);
    byType[t] = { n: idx.length, engagement: median(idx.map((i: number) => eng[i])) };
  }
  return {
    username: b.username, name: b.name, biography: b.biography, followers: b.followers_count, posts: b.media_count,
    perWeek: span > 0 ? Number(((media.length / span) * 7).toFixed(1)) : null, medianEngagement: median(eng), byType,
    top: media.map((m: any, i: number) => ({ ...m, engagement: eng[i] })).sort((p: any, q: any) => q.engagement - p.engagement).slice(0, 5),
    fetchedAt: now(),
  };
}

const REC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'bio', 'recommendations', 'dataNote'],
  properties: {
    summary: { type: 'string' },
    bio: { type: 'object', additionalProperties: false, required: ['assessment', 'suggestion'], properties: { assessment: { type: 'string' }, suggestion: { type: 'string' } } },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'evidence', 'change', 'expected', 'metric', 'kind'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string', description: 'Dado observado, com números e posts' },
          change: { type: 'string' },
          expected: { type: 'string', description: 'Resultado a testar (sem promessa)' },
          metric: { type: 'string' },
          kind: { type: 'string', enum: ['verificado', 'observação', 'hipótese'] },
        },
      },
    },
    dataNote: { type: 'string', description: 'Limitações: quantidade de dados, período, o que não dá para concluir' },
  },
};

const ANALYST = `Você é um analista de conteúdo e performance de redes sociais da agência GDR, em português do Brasil.
Regras: use SOMENTE os números fornecidos. Compare posts em condições equivalentes (mesmo formato e período). Não declare "modelo ideal" com base em um único post.
Não transforme correlação em certeza: classifique cada ponto como "verificado" (dado direto), "observação" (padrão nos dados) ou "hipótese" (algo a testar).
Cada recomendação precisa de: evidência observada, mudança sugerida, resultado esperado a testar e métrica a acompanhar. Seja específico e prático.`;

export async function intelligenceRoutes(app: FastifyInstance) {
  // ---- análise do perfil ----
  app.post('/api/intel/profile', async (req) => {
    const { brandId, since, until } = (req.body ?? {}) as { brandId: string; since: string; until: string };
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId));
    const acc = igAccount(brandId);
    const days = (Date.parse(until) - Date.parse(since)) / 86400_000;
    const media = mediaOf(acc.id, new Date(since).toISOString(), new Date(until).toISOString());
    const stats = computeStats(media, days);
    let profile: any = {};
    try {
      profile = await (await metaFetch(`${G()}/${acc.external_id}?fields=username,name,biography,website,followers_count,media_count&access_token=${unseal(acc.token)}`)).json();
    } catch {
      /* perfil indisponível */
    }
    if (!media.length) return { profile, stats, analysis: null, note: 'Nenhum post sincronizado no período. Clique em "Atualizar dados" no Painel.' };
    try {
      const top = [...media].sort((a, b) => (b.metrics.views ?? 0) - (a.metrics.views ?? 0));
      const r = await generateJson<any>({
        system: ANALYST,
        prompt: `${brandContext(brand.name, brand.profile).text}

# Perfil @${profile.username ?? acc.username}
Nome: ${profile.name ?? '—'} · Seguidores: ${profile.followers_count ?? '—'} · Link: ${profile.website ?? 'nenhum'}
Bio: """${profile.biography ?? ''}"""

# Período: ${since.slice(0, 10)} a ${until.slice(0, 10)} (${Math.round(days)} dias) · ${stats.posts} posts · ${stats.perWeek} por semana
Por formato (medianas): ${JSON.stringify(stats.byType)}
Por dia da semana (mediana de visualizações): ${JSON.stringify(stats.byWeekday)}
Por horário: ${JSON.stringify(stats.byTime)}
Melhores posts: ${JSON.stringify(top.slice(0, 6))}
Piores posts: ${JSON.stringify(top.slice(-4))}`,
        schema: REC_SCHEMA,
        maxTokens: 6000,
      });
      return { profile, stats, analysis: r.data, model: r.model, at: now() };
    } catch (e) {
      throw asApp(e);
    }
  });

  // ---- perguntas aos dados ----
  app.post('/api/intel/ask', async (req) => {
    const { brandId, question, since, until, history } = (req.body ?? {}) as { brandId: string; question: string; since: string; until: string; history?: { q: string; a: string }[] };
    if (!question?.trim()) throw badRequest('Escreva a pergunta.');
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId));
    const accs = db.prepare("SELECT * FROM social_accounts WHERE brand_id = ? AND network IN ('instagram','facebook') AND token IS NOT NULL").all(brandId) as any[];
    const media = accs.flatMap((a) => mediaOf(a.id, new Date(since).toISOString(), new Date(until).toISOString()).map((m) => ({ ...m, perfil: a.username ?? a.name, rede: a.network })));
    const days = (Date.parse(until) - Date.parse(since)) / 86400_000;
    const totals = (db.prepare("SELECT key, data FROM insight_cache WHERE key LIKE 'tot:%'").all() as any[]).filter((c) => accs.some((a) => c.key.startsWith(`tot:${a.id}:${Math.floor(Date.parse(since) / 1000)}`))).map((c) => JSON.parse(c.data).totals);
    try {
      const r = await generateJson<any>({
        system: `${ANALYST}
Responda a pergunta do usuário com base nos dados. Cite os posts (data, formato e números) que sustentam a resposta.
Limitações importantes: a Meta não informa quantos seguidores cada post gerou individualmente (só o total da conta e, em alguns posts, "follows"); se a pergunta depender disso, explique.
Se fizer sentido, sugira ações convertíveis em pauta, roteiro ou tarefa.`,
        prompt: `${brandContext(brand.name, brand.profile).text}
# Período ${since.slice(0, 10)} a ${until.slice(0, 10)} (${Math.round(days)} dias)
Totais da conta (Meta): ${JSON.stringify(totals)}
Estatísticas: ${JSON.stringify(computeStats(media, days))}
Posts (${media.length}): ${JSON.stringify(media.slice(0, 80))}
${(history ?? []).slice(-4).map((h) => `Pergunta anterior: ${h.q}\nResposta anterior: ${h.a}`).join('\n')}
Pergunta: ${question}`,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['answer', 'references', 'limitations', 'actions'],
          properties: {
            answer: { type: 'string' },
            references: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['postId', 'why'], properties: { postId: { type: 'string' }, why: { type: 'string' } } } },
            limitations: { type: 'string' },
            actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'details'], properties: { kind: { type: 'string', enum: ['pauta', 'roteiro', 'tarefa'] }, title: { type: 'string' }, details: { type: 'string' } } } },
          },
        },
        maxTokens: 6000,
      });
      const byId = new Map(media.map((m) => [m.id, m]));
      return { ...r.data, references: (r.data.references ?? []).map((x: any) => ({ ...x, post: byId.get(x.postId) ?? null })), model: r.model, posts: media.length };
    } catch (e) {
      throw asApp(e);
    }
  });

  // ---- concorrentes e referências (perfis profissionais públicos via API oficial) ----
  app.get('/api/intel/competitors', async (req) => getSetting<string[]>(`brand.competitors.${(req.query as any).brandId}`, []));
  app.put('/api/intel/competitors', async (req) => {
    const { brandId, usernames } = (req.body ?? {}) as { brandId: string; usernames: string[] };
    setSetting(`brand.competitors.${brandId}`, (usernames ?? []).map((u) => String(u).trim().replace(/^@/, '').toLowerCase()).filter(Boolean).slice(0, 10));
    return { ok: true };
  });

  app.post('/api/intel/benchmark', async (req) => {
    const { brandId } = (req.body ?? {}) as { brandId: string };
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId));
    const acc = igAccount(brandId);
    const users = getSetting<string[]>(`brand.competitors.${brandId}`, []);
    if (!users.length) throw badRequest('Informe ao menos um concorrente ou referência.', 'Use o @ de perfis profissionais (empresa ou criador).');
    const own = await competitorData(acc, acc.username).catch(() => null);
    const comps: any[] = [];
    const errors: string[] = [];
    for (const u of users) {
      try {
        comps.push(await competitorData(acc, u));
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    let synthesis: any = null;
    if (comps.length) {
      try {
        synthesis = (
          await generateJson<any>({
            system: `${ANALYST}\nCompare a marca com as referências usando a taxa de engajamento ((curtidas+comentários)/seguidores) — perfis de tamanhos diferentes não se comparam por números absolutos.`,
            prompt: `${brandContext(brand.name, brand.profile).text}\n# Marca\n${JSON.stringify(own)}\n# Referências\n${JSON.stringify(comps)}`,
            schema: REC_SCHEMA,
            maxTokens: 6000,
          })
        ).data;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    return { own, competitors: comps, synthesis, errors, at: now() };
  });

  // ---- tendências na web (precisa da Busca do Google no Gemini) ----
  app.post('/api/intel/trends', async (req) => {
    const { brandId, focus } = (req.body ?? {}) as { brandId: string; focus?: string };
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId));
    try {
      const r = await geminiResearch(
        'Você pesquisa tendências de conteúdo para redes sociais no Brasil. Para cada item, informe a data da informação e classifique como [VERIFICADO] (há fonte), [OBSERVAÇÃO] ou [HIPÓTESE]. Não invente dados nem números.',
        `Marca: ${brand.name}. Nicho e público: ${brand.profile.description || ''} ${brand.profile.audience || ''}. Foco: ${focus || 'temas em crescimento, dúvidas do público, formatos e oportunidades de pauta'}. Liste até 8 itens com: tema, por que está em alta, ideia de pauta.`,
      );
      return { available: true, ...r };
    } catch (e) {
      if (e instanceof AiError && /Limite gratuito/.test(e.message)) {
        return { available: false, reason: 'A pesquisa na web com fontes usa a Busca do Google do Gemini, que não está liberada no plano gratuito da sua chave. Para ativar, habilite o faturamento do projeto no Google AI Studio. Sem isso, o GDR Digital não apresenta tendências (para não mostrar nada sem fonte) — use "Concorrentes e referências", que funciona com dados reais e grátis.' };
      }
      throw asApp(e);
    }
  });

  // ---- pautas ----
  const rowToIdea = (r: any) => ({ id: r.id, brandId: r.brand_id, title: r.title, details: r.details, source: r.source, status: r.status, script: r.script, projectId: r.project_id, createdAt: r.created_at });
  app.get('/api/ideas', async (req) => (db.prepare('SELECT * FROM ideas WHERE brand_id = ? ORDER BY created_at DESC').all((req.query as any).brandId) as any[]).map(rowToIdea));
  app.post('/api/ideas', async (req) => {
    const b = (req.body ?? {}) as { brandId: string; title: string; details?: string; source?: string };
    if (!b.title?.trim()) throw badRequest('Dê um título para a pauta.');
    const id = uid('id_');
    db.prepare('INSERT INTO ideas (id, brand_id, title, details, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, b.brandId, b.title.trim().slice(0, 200), String(b.details ?? '').slice(0, 4000), b.source ?? 'manual', 'idea', now(), now());
    return rowToIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(id));
  });
  app.patch('/api/ideas/:id', async (req) => {
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as { title?: string; details?: string; status?: string; script?: string };
    const cur = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as any;
    if (!cur) throw notFound('Pauta');
    db.prepare('UPDATE ideas SET title = ?, details = ?, status = ?, script = ?, updated_at = ? WHERE id = ?').run(b.title ?? cur.title, b.details ?? cur.details, b.status && ['idea', 'script', 'production', 'done'].includes(b.status) ? b.status : cur.status, b.script ?? cur.script, now(), id);
    return rowToIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(id));
  });
  app.delete('/api/ideas/:id', async (req) => {
    db.prepare('DELETE FROM ideas WHERE id = ?').run((req.params as any).id);
    return { ok: true };
  });

  app.post('/api/ideas/:id/script', async (req) => {
    const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get((req.params as any).id) as any;
    if (!idea) throw notFound('Pauta');
    const brand = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(idea.brand_id));
    try {
      const r = await generateJson<{ hook: string; script: string; cta: string; shots: string }>({
        system: 'Você é roteirista de vídeos curtos (Reels/TikTok) para marcas brasileiras. Escreva roteiros falados, naturais, com gancho forte nos 3 primeiros segundos, sem clichês e sem prometer resultados ou inventar dados.',
        prompt: `${brandContext(brand.name, brand.profile).text}\n# Pauta\n${idea.title}\n${idea.details}\nEscreva um roteiro de 30 a 60 segundos.`,
        schema: { type: 'object', additionalProperties: false, required: ['hook', 'script', 'cta', 'shots'], properties: { hook: { type: 'string' }, script: { type: 'string' }, cta: { type: 'string' }, shots: { type: 'string', description: 'Sugestão de cenas/takes' } } },
        maxTokens: 4000,
      });
      const text = `GANCHO: ${r.data.hook}\n\nROTEIRO:\n${r.data.script}\n\nCTA: ${r.data.cta}\n\nCENAS SUGERIDAS:\n${r.data.shots}`;
      db.prepare("UPDATE ideas SET script = ?, status = CASE WHEN status = 'idea' THEN 'script' ELSE status END, updated_at = ? WHERE id = ?").run(text, now(), idea.id);
      return rowToIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id));
    } catch (e) {
      throw asApp(e);
    }
  });

  app.post('/api/ideas/:id/project', async (req) => {
    const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get((req.params as any).id) as any;
    if (!idea) throw notFound('Pauta');
    if (idea.project_id && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(idea.project_id)) return { projectId: idea.project_id };
    const pid = uid('p_');
    db.prepare("INSERT INTO projects (id, brand_id, name, status, timeline, revision, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, 0, ?, ?)").run(pid, idea.brand_id, idea.title.slice(0, 120), JSON.stringify(emptyTimeline('9:16')), now(), now());
    db.prepare("UPDATE ideas SET project_id = ?, status = 'production', updated_at = ? WHERE id = ?").run(pid, now(), idea.id);
    return { projectId: pid };
  });
}
