import type { FastifyInstance } from 'fastify';
import { db, now } from '../db.ts';
import { badRequest, notFound, AppError } from '../lib/errors.ts';
import { EMPTY_PROFILE, rowToBrand } from '../lib/mappers.ts';
import { uid } from '../../../shared/timeline.ts';
import type { BrandProfile } from '../../../shared/types.ts';

function slugify(s: string) {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'marca'
  );
}

/** Campos do perfil que ajudam a IA e precisam ser preenchidos pelo responsável. */
export const REQUIRED_FIELDS: [keyof BrandProfile, string][] = [
  ['description', 'Descrição'],
  ['productsServices', 'Produtos e serviços'],
  ['audience', 'Público'],
  ['positioning', 'Posicionamento'],
  ['objectives', 'Objetivos'],
  ['toneOfVoice', 'Tom de voz'],
  ['wordsToUse', 'Expressões a usar'],
  ['wordsToAvoid', 'Expressões a evitar'],
  ['colors', 'Cores'],
  ['logoAssetId', 'Logo'],
];

export function missingFields(p: BrandProfile): string[] {
  return REQUIRED_FIELDS.filter(([k]) => {
    const v = p[k];
    if (Array.isArray(v)) return v.length === 0;
    return v === null || String(v ?? '').trim() === '';
  }).map(([, l]) => l);
}

const STR_FIELDS: (keyof BrandProfile)[] = ['description', 'productsServices', 'audience', 'positioning', 'objectives', 'toneOfVoice', 'communicationExamples', 'wordsToUse', 'wordsToAvoid', 'fonts', 'visualReferences', 'knowledgeBase'];

function sanitizeProfile(input: any, base: BrandProfile): BrandProfile {
  const p: BrandProfile = { ...base };
  for (const k of STR_FIELDS) if (typeof input?.[k] === 'string') (p as any)[k] = input[k].slice(0, 20000);
  if (Array.isArray(input?.colors)) {
    p.colors = input.colors
      .filter((c: any) => typeof c?.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.hex))
      .slice(0, 12)
      .map((c: any) => ({ name: String(c.name ?? '').slice(0, 40), hex: c.hex.toUpperCase() }));
  }
  if (input && 'logoAssetId' in input) p.logoAssetId = input.logoAssetId || null;
  if (input && 'captionStyle' in input) p.captionStyle = input.captionStyle && typeof input.captionStyle === 'object' ? input.captionStyle : null;
  return p;
}

export async function brandRoutes(app: FastifyInstance) {
  app.get('/api/brands', async () => {
    const rows = db.prepare('SELECT * FROM brands ORDER BY name COLLATE NOCASE').all();
    return rows.map((r) => {
      const b = rowToBrand(r);
      return { ...b, missing: missingFields(b.profile) };
    });
  });

  app.get('/api/brands/:id', async (req) => {
    const r = db.prepare('SELECT * FROM brands WHERE id = ?').get((req.params as any).id);
    if (!r) throw notFound('Marca');
    const b = rowToBrand(r);
    return { ...b, missing: missingFields(b.profile) };
  });

  app.post('/api/brands', async (req) => {
    const body = (req.body ?? {}) as { name?: string; profile?: any };
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('Informe o nome da marca.');
    let slug = slugify(name);
    let n = 2;
    while (db.prepare('SELECT 1 FROM brands WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${n++}`;
    const id = uid('b_');
    const profile = sanitizeProfile(body.profile ?? {}, EMPTY_PROFILE);
    db.prepare('INSERT INTO brands (id, name, slug, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, slug, JSON.stringify(profile), now(), now());
    const b = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(id));
    return { ...b, missing: missingFields(b.profile) };
  });

  app.put('/api/brands/:id', async (req) => {
    const id = (req.params as any).id;
    const r = db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
    if (!r) throw notFound('Marca');
    const cur = rowToBrand(r);
    const body = (req.body ?? {}) as { name?: string; profile?: any };
    const name = body.name !== undefined ? String(body.name).trim() : cur.name;
    if (!name) throw badRequest('O nome da marca não pode ficar vazio.');
    const profile = sanitizeProfile(body.profile ?? {}, cur.profile);
    if (profile.logoAssetId) {
      const a = db.prepare("SELECT 1 FROM assets WHERE id = ? AND brand_id = ? AND kind = 'image'").get(profile.logoAssetId, id);
      if (!a) throw badRequest('O logo escolhido não é uma imagem desta marca.', 'Envie o logo na Biblioteca desta marca e selecione-o novamente.');
    }
    db.prepare('UPDATE brands SET name = ?, profile = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(profile), now(), id);
    const b = rowToBrand(db.prepare('SELECT * FROM brands WHERE id = ?').get(id));
    return { ...b, missing: missingFields(b.profile) };
  });

  app.delete('/api/brands/:id', async (req) => {
    const id = (req.params as any).id;
    const projects = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE brand_id = ?').get(id) as { n: number };
    if (projects.n > 0) throw new AppError(409, `Esta marca tem ${projects.n} projeto(s).`, 'Exclua ou mova os projetos antes de excluir a marca. Os arquivos originais ficam preservados até lá.');
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    return { ok: true };
  });
}
