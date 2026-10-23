// Geração do texto da publicação (post) a partir do conteúdo real do vídeo editado
// e do contexto da marca. Não confundir com as legendas sincronizadas dentro do vídeo.
import type { BrandProfile, Timeline } from '../../../shared/types.ts';
import { mapCuesToTimeline } from '../../../shared/captions.ts';
import { timelineDuration } from '../../../shared/timeline.ts';
import { generateJson } from './providers.ts';

export const NETWORKS: Record<string, { label: string; guide: string }> = {
  instagram: { label: 'Instagram (Reels/Feed)', guide: 'Legenda de Instagram. A primeira linha aparece antes do "mais": precisa prender sozinha. Parágrafos curtos, até ~1.200 caracteres. 3 a 5 hashtags específicas no final, se fizerem sentido.' },
  tiktok: { label: 'TikTok', guide: 'Texto curto e direto (até ~300 caracteres), linguagem natural de TikTok, 2 a 4 hashtags relevantes.' },
  facebook: { label: 'Facebook', guide: 'Texto conversacional, pode ser um pouco mais explicativo, hashtags opcionais (no máximo 2).' },
  linkedin: { label: 'LinkedIn', guide: 'Tom profissional e humano, foco em aprendizado/resultado, parágrafos curtos, sem excesso de emojis, até 3 hashtags.' },
  youtube: { label: 'YouTube Shorts', guide: 'Gere no campo hook um título de até 70 caracteres; no body uma descrição curta; hashtags 2 a 3.' },
};

const PROFILE_FIELDS: [keyof BrandProfile, string][] = [
  ['description', 'Descrição da marca'],
  ['productsServices', 'Produtos e serviços'],
  ['audience', 'Público'],
  ['positioning', 'Posicionamento'],
  ['objectives', 'Objetivos'],
  ['toneOfVoice', 'Tom de voz'],
  ['communicationExamples', 'Exemplos de comunicação'],
  ['wordsToUse', 'Expressões a usar'],
  ['wordsToAvoid', 'Expressões a evitar'],
  ['knowledgeBase', 'Base de conhecimento'],
];

export function brandContext(name: string, p: BrandProfile) {
  const filled: string[] = [];
  const missing: string[] = [];
  for (const [k, label] of PROFILE_FIELDS) {
    const v = String(p[k] ?? '').trim();
    if (v) filled.push(`## ${label}\n${v}`);
    else missing.push(label);
  }
  return { text: `# Marca: ${name}\n\n${filled.join('\n\n') || '(perfil da marca ainda não preenchido)'}`, missing };
}

/** Fala que permaneceu no vídeo após os cortes, em ordem. */
export function finalTranscript(tl: Timeline): string {
  return mapCuesToTimeline(tl)
    .map((c) => c.words.map((w) => w.text).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CopyVariation {
  approach: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
  fullText: string;
}

export interface CopyResult {
  summary: string;
  variations: CopyVariation[];
  notes: string[];
  missingInfo: string[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'variations', 'notes', 'missingInfo'],
  properties: {
    summary: { type: 'string', description: 'Resumo objetivo do que o vídeo realmente diz (1-2 frases).' },
    variations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['approach', 'hook', 'body', 'cta', 'hashtags', 'fullText'],
        properties: {
          approach: { type: 'string', description: 'Nome curto da abordagem (ex.: "Dor do cliente", "Bastidor", "Resultado").' },
          hook: { type: 'string' },
          body: { type: 'string' },
          cta: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          fullText: { type: 'string', description: 'Texto final pronto para colar, com quebras de linha.' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Alertas: afirmações a confirmar, informações que você evitou inventar.' },
    missingInfo: { type: 'array', items: { type: 'string' }, description: 'Informações da marca que melhorariam o texto e não foram fornecidas.' },
  },
};

const SYSTEM = `Você é um copywriter sênior brasileiro que escreve textos de publicação para redes sociais de marcas e agências.
Princípios:
- Baseie-se SOMENTE no conteúdo real do vídeo (transcrição) e no contexto da marca fornecido. Nunca invente números, preços, prazos, resultados, depoimentos, garantias ou nomes.
- Texto humano, específico e persuasivo. Evite clichês ("você não vai acreditar", "o segredo que ninguém conta", "transforme sua vida"), exageros, promessas de viralização e linguagem artificial.
- Gancho relevante para o público, desenvolvimento claro, CTA coerente com o objetivo.
- Respeite o tom de voz e as expressões a usar/evitar da marca.
- Português do Brasil.
- Se algo importante faltar, escreva sem inventar e registre em notes/missingInfo.`;

export async function generatePostCopy(input: {
  brandName: string;
  profile: BrandProfile;
  timeline: Timeline;
  network: string;
  objective: string;
  notes: string;
  variations: number;
}) {
  const ctx = brandContext(input.brandName, input.profile);
  const transcript = finalTranscript(input.timeline);
  const net = NETWORKS[input.network] ?? NETWORKS.instagram;
  const duration = Math.round(timelineDuration(input.timeline));
  const prompt = `${ctx.text}

# Vídeo
Formato: ${input.timeline.format.preset} (${input.timeline.format.width}x${input.timeline.format.height}), duração ${duration}s.
Transcrição da fala que ficou no vídeo final:
"""
${transcript || '(sem fala transcrita — o vídeo pode não ter narração; baseie-se apenas nas observações abaixo e não invente o conteúdo)'}
"""

# Pedido
Rede: ${net.label}. ${net.guide}
Objetivo da publicação: ${input.objective || 'não informado — escolha o mais coerente com o vídeo e diga qual escolheu em notes'}.
Observações do responsável: ${input.notes || 'nenhuma'}.
Gere ${input.variations} variação(ões) com abordagens diferentes entre si.`;

  const r = await generateJson<CopyResult>({ system: SYSTEM, prompt, schema: SCHEMA, maxTokens: 12000 });
  const data = r.data;
  data.missingInfo = Array.from(new Set([...(data.missingInfo ?? []), ...ctx.missing.map((m) => `Perfil da marca: ${m}`)]));
  return { ...r, data, transcriptUsed: transcript };
}
