// Importação manual de métricas (planilha/CSV): para redes sem API conectada (ex.: TikTok) ou números de outra fonte.
// Os dados importados ficam SEMPRE identificados como manuais, com o arquivo e a data da importação.

export const IMPORT_COLUMNS = ['data', 'link', 'tipo', 'legenda', 'visualizacoes', 'alcance', 'curtidas', 'comentarios', 'compartilhamentos', 'salvamentos'] as const;

const ALIASES: Record<string, string> = {
  data: 'date', date: 'date', 'data de publicacao': 'date', publicado: 'date', 'publicado em': 'date',
  link: 'link', url: 'link', permalink: 'link',
  tipo: 'type', formato: 'type', type: 'type',
  legenda: 'caption', texto: 'caption', descricao: 'caption', caption: 'caption', titulo: 'caption',
  visualizacoes: 'views', views: 'views', plays: 'views', reproducoes: 'views', impressoes: 'views',
  alcance: 'reach', reach: 'reach', 'contas alcancadas': 'reach',
  curtidas: 'likes', likes: 'likes', 'gostei': 'likes',
  comentarios: 'comments', comments: 'comments',
  compartilhamentos: 'shares', shares: 'shares',
  salvamentos: 'saved', salvos: 'saved', saves: 'saved', favoritos: 'saved',
};

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Divide uma linha CSV respeitando aspas. */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') (cur += '"'), i++;
      else q = !q;
    } else if (ch === sep && !q) (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** "1.234", "1,2 mil", "3,4K", "2.5M" → número. Vazio → null (nunca inventa zero). */
export function parseNumber(v: string): number | null {
  let s = norm(v).replace(/ /g, '');
  if (!s) return null;
  let mult = 1;
  if (/(mil|k)$/.test(s)) (mult = 1e3), (s = s.replace(/(mil|k)$/, ''));
  else if (/(mi|m)$/.test(s)) (mult = 1e6), (s = s.replace(/(mi|m)$/, ''));
  const raw = String(v).replace(/[^\d.,-]/g, '');
  let n: number;
  if (mult > 1) n = Number(raw.replace(',', '.'));
  else if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) n = Number(raw.replace(/[.,]/g, ''));
  else n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

/** "23/10/2026", "2026-10-23", "23/10/2026 18:30" → ISO. */
export function parseDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 12), Number(m[5] ?? 0));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(s.length > 10 ? s : `${s}T12:00:00`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export interface ImportedRow {
  postedAt: string;
  link: string | null;
  type: string;
  caption: string;
  metrics: Record<string, number>;
}

export function parseMetricsCsv(text: string): { rows: ImportedRow[]; errors: string[]; columns: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], errors: ['O arquivo precisa ter um cabeçalho e ao menos uma linha.'], columns: [] };
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const head = splitLine(lines[0], sep).map((h) => ALIASES[norm(h)] ?? null);
  const errors: string[] = [];
  if (!head.includes('date')) errors.push('Falta a coluna "data".');
  const rows: ImportedRow[] = [];
  lines.slice(1).forEach((line, i) => {
    const cells = splitLine(line, sep);
    const get = (k: string) => {
      const j = head.indexOf(k);
      return j >= 0 ? cells[j] ?? '' : '';
    };
    const postedAt = parseDate(get('date'));
    if (!postedAt) return void errors.push(`Linha ${i + 2}: data inválida ("${get('date')}"). Use 23/10/2026 ou 2026-10-23.`);
    const metrics: Record<string, number> = {};
    for (const k of ['views', 'reach', 'likes', 'comments', 'shares', 'saved']) {
      const n = parseNumber(get(k));
      if (n !== null) metrics[k] = n;
    }
    const t = norm(get('type'));
    const type = /reel|video|tiktok|short/.test(t) ? 'reel' : /carross|carousel/.test(t) ? 'carousel' : /imag|foto|post/.test(t) ? 'image' : t || 'post';
    rows.push({ postedAt, link: get('link') || null, type, caption: get('caption').slice(0, 2000), metrics });
  });
  return { rows, errors, columns: head.filter(Boolean) as string[] };
}
