// Edição por linguagem natural: a IA lê a fala (com tempos), o estado do projeto e a marca,
// e devolve um PLANO de ações do catálogo. Nada é aplicado sem revisão na interface.
import type { Asset, BrandProfile, CaptionWord, Timeline } from '../../../shared/types.ts';
import { buildCues, mapCuesToTimeline } from '../../../shared/captions.ts';
import { layoutClips, timelineDuration } from '../../../shared/timeline.ts';
import { ACTION_CATALOG, type EditAction } from '../../../shared/edit-actions.ts';
import { generateJson } from './providers.ts';

const SCHEMA = {
  type: 'object',
  required: ['reply', 'actions', 'question'],
  properties: {
    reply: { type: 'string', description: 'Resposta curta em português explicando o que será feito.' },
    question: { type: 'string', description: 'Pergunta objetiva quando houver ambiguidade relevante; senão, string vazia.' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['remove_pauses', 'cut', 'keep_only', 'captions', 'logo', 'text', 'transitions', 'filter', 'zoom', 'dynamic_zoom', 'speed', 'music', 'format', 'denoise', 'pip', 'broll', 'rhythm'] },
          start: { type: 'number' },
          end: { type: 'number' },
          duration: { type: 'number' },
          minGap: { type: 'number' },
          preset: { type: 'string' },
          highlightColor: { type: 'string' },
          uppercase: { type: 'boolean' },
          position: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['title', 'lower', 'cta'] },
          anim: { type: 'string', enum: ['fade', 'pop', 'slide', 'none'] },
          transition: { type: 'string', enum: ['fade', 'flash', 'zoom'] },
          scale: { type: 'number' },
          speed: { type: 'number' },
          assetId: { type: 'string' },
          volume: { type: 'number' },
          ducking: { type: 'boolean' },
          level: { type: 'string', enum: ['light', 'strong'] },
          shotLength: { type: 'number' },
        },
      },
    },
  },
};

const SYSTEM = `Você é o editor de vídeo do GDR Orbit. Converta o pedido do usuário em ações do catálogo.
Regras:
- Use SOMENTE ações e parâmetros do catálogo. Tempos em segundos da timeline atual, baseados na transcrição fornecida.
- Nunca corte no meio de uma fala nem remova trechos que mudem o sentido do que foi dito.
- Preserve o que já foi feito; altere só o necessário para o novo pedido (não refaça o projeto inteiro).
- Títulos/chamadas: textos curtos, fiéis ao que é dito; não invente números, preços ou promessas.
- Se o pedido exigir algo fora do catálogo, diga o que não é possível ainda em "reply" e faça o restante.
- Se houver ambiguidade relevante, pergunte em "question" com opções objetivas e não aplique ações arriscadas.
- Responda em português do Brasil, de forma curta.`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export async function planEdit(input: {
  message: string;
  history: ChatTurn[];
  timeline: Timeline;
  transcripts: Record<string, CaptionWord[]>;
  assets: Asset[];
  brandName: string;
  profile: BrandProfile;
}) {
  const tl = input.timeline;
  // Usa as legendas existentes; sem elas, monta a fala a partir das transcrições (só para contexto).
  let ctxTl = tl;
  if (!tl.captions.cues.length) {
    const cues = Array.from(new Set(tl.clips.map((c) => c.assetId))).flatMap((id) =>
      input.transcripts[id] ? buildCues(id, input.transcripts[id], { maxWordsPerCue: 10, maxCharsPerLine: 60 }) : [],
    );
    ctxTl = { ...tl, captions: { ...tl.captions, cues } };
  }
  const speech = mapCuesToTimeline(ctxTl)
    .map((c) => `[${c.start.toFixed(1)}–${c.end.toFixed(1)}] ${c.words.map((w) => w.text).join(' ')}`)
    .slice(0, 600)
    .join('\n');
  const clips = layoutClips(tl.clips)
    .map((p, i) => `#${i + 1} ${p.start.toFixed(1)}–${p.end.toFixed(1)}s${p.clip.speed !== 1 ? ` vel ${p.clip.speed}x` : ''}${p.clip.color ? ` filtro ${p.clip.color.preset}` : ''}${p.clip.zoom ? ' zoom' : ''}${p.clip.transition ? ` transição ${p.clip.transition.type}` : ''}`)
    .join('\n');
  const music = input.assets.filter((a) => a.kind === 'audio' && a.status === 'ready');
  const visuals = input.assets.filter((a) => (a.kind === 'video' || a.kind === 'image') && a.status === 'ready').slice(0, 40);
  const prompt = `${ACTION_CATALOG}

# Projeto (marca ${input.brandName})
Formato ${tl.format.preset}, duração ${timelineDuration(tl).toFixed(1)}s.
Trechos:
${clips || '(vazio)'}
Legendas: ${tl.captions.cues.length ? `${tl.captions.cues.length} (estilo ${tl.captions.style.preset})` : 'não geradas'}. Títulos: ${(tl.texts ?? []).map((t) => `"${t.text}" ${t.start.toFixed(1)}s`).join(', ') || 'nenhum'}.
Logo da marca: ${input.profile.logoAssetId ? 'disponível' : 'não definido'}${(tl.overlays ?? []).length ? ' (já aplicado)' : ''}. Cores da marca: ${input.profile.colors.map((c) => c.hex).join(', ') || 'não definidas'}.
Vídeos e imagens na biblioteca (para pip/broll): ${visuals.map((m) => `${m.id} ${m.kind} "${m.name}"${m.meta.duration ? ` ${m.meta.duration.toFixed(0)}s` : ''}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}`).join('; ') || 'nenhum'}.
Faixas extras: ${(tl.layers ?? []).length} sobreposições, ${(tl.audioClips ?? []).length} áudios. Redução de ruído: ${tl.clips.some((c) => c.denoise) ? 'ligada' : 'desligada'}.
Músicas na biblioteca: ${music.map((m) => `${m.id} "${m.name}"${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}`).join('; ') || 'nenhuma'}.
Tom de voz: ${input.profile.toneOfVoice || 'não informado'}.

# Fala com tempos (timeline atual)
${speech || '(sem transcrição — ações que dependem de fala não estão disponíveis)'}

# Conversa
${input.history.slice(-6).map((h) => `${h.role === 'user' ? 'Usuário' : 'Editor'}: ${h.text}`).join('\n')}
Usuário: ${input.message}`;

  const r = await generateJson<{ reply: string; actions: EditAction[]; question: string }>({ system: SYSTEM, prompt, schema: SCHEMA, maxTokens: 6000 });
  return { ...r.data, actions: (r.data.actions ?? []).slice(0, 30), provider: r.provider, model: r.model };
}
