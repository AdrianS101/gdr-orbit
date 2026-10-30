// Catálogo de fontes disponíveis para legendas.
// O mesmo arquivo de fonte é enviado à prévia (libass/WASM) e copiado para a renderização (FFmpeg/libass).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../db.ts';
import { assetPath } from './storage.ts';

export interface FontEntry {
  family: string;
  style: string;
  file: string;
  source: 'sistema' | 'marca' | 'app';
  brandId?: string;
  assetId?: string;
}

/** Lê nome da família e estilo da tabela 'name' de um arquivo TTF/OTF. */
export function readFontNames(buf: Buffer): { family: string; style: string; typoFamily?: string } | null {
  try {
    let base = 0;
    if (buf.toString('ascii', 0, 4) === 'ttcf') base = buf.readUInt32BE(12);
    const numTables = buf.readUInt16BE(base + 4);
    let nameOff = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (buf.toString('ascii', rec, rec + 4) === 'name') nameOff = buf.readUInt32BE(rec + 8);
    }
    if (nameOff < 0) return null;
    const count = buf.readUInt16BE(nameOff + 2);
    const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
    const names: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const platform = buf.readUInt16BE(r);
      const lang = buf.readUInt16BE(r + 4);
      const nameId = buf.readUInt16BE(r + 6);
      const len = buf.readUInt16BE(r + 8);
      const off = buf.readUInt16BE(r + 10);
      if (![1, 2, 16, 17].includes(nameId)) continue;
      const raw = buf.subarray(strOff + off, strOff + off + len);
      let s: string;
      if (platform === 3 || platform === 0) {
        if (platform === 3 && lang !== 0x0409 && names[nameId]) continue;
        const sw = Buffer.from(raw);
        sw.swap16();
        s = sw.toString('utf16le');
      } else {
        if (names[nameId]) continue;
        s = raw.toString('latin1');
      }
      names[nameId] = s;
    }
    if (!names[1]) return null;
    return { family: names[1], style: names[2] ?? 'Regular', typoFamily: names[16] };
  } catch {
    return null;
  }
}

let systemCache: FontEntry[] | null = null;

function systemFontDirs(): string[] {
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')];
  return ['/usr/share/fonts', path.join(os.homedir(), '.fonts')];
}

export function systemFonts(): FontEntry[] {
  if (systemCache) return systemCache;
  const out: FontEntry[] = [];
  const walk = (d: string, depth = 0) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (/\.(ttf|otf)$/i.test(e.name)) {
        try {
          const n = readFontNames(fs.readFileSync(f));
          if (n) out.push({ family: n.family, style: n.style, file: f, source: 'sistema' });
        } catch {
          /* ignora fontes ilegíveis */
        }
      }
    }
  };
  systemFontDirs().forEach((d) => walk(d));
  systemCache = out;
  return out;
}

let appCache: FontEntry[] | null = null;
/** Fontes embutidas no GDR Digital (server/fonts), usadas pela legenda profissional. */
export function appFonts(): FontEntry[] {
  if (appCache) return appCache;
  const dir = path.join(import.meta.dirname, '..', '..', 'fonts');
  appCache = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/\.(ttf|otf)$/i.test(name)) continue;
    const n = readFontNames(fs.readFileSync(path.join(dir, name)));
    if (n) appCache.push({ family: n.family, style: n.style, file: path.join(dir, name), source: 'app' });
  }
  return appCache;
}

export function brandFonts(brandId: string): FontEntry[] {
  const rows = db.prepare("SELECT id, brand_id, ext, meta FROM assets WHERE brand_id = ? AND kind = 'font'").all(brandId) as any[];
  return rows.map((r) => {
    const meta = JSON.parse(r.meta);
    return { family: meta.family, style: meta.style, file: assetPath(r.brand_id, r.id, 'original', r.ext), source: 'marca', brandId: r.brand_id, assetId: r.id } as FontEntry;
  });
}

/** Fontes recomendadas para legenda que costumam existir no Windows. */
export const SUGGESTED_FAMILIES = ['Arial Black', 'Impact', 'Segoe UI Black', 'Segoe UI', 'Bahnschrift', 'Verdana', 'Arial', 'Montserrat', 'Poppins', 'Inter'];

export function listFonts(brandId?: string) {
  const all = [...(brandId ? brandFonts(brandId) : []), ...appFonts(), ...systemFonts()];
  const families = new Map<string, FontEntry[]>();
  for (const f of all) {
    const list = families.get(f.family) ?? [];
    list.push(f);
    families.set(f.family, list);
  }
  return families;
}

/** Arquivo principal de uma família (prefere Regular/Bold conforme pedido). */
export function resolveFontFiles(family: string, bold: boolean, brandId?: string): FontEntry[] {
  const list = listFonts(brandId).get(family) ?? [];
  if (!list.length) return [];
  const want = bold ? /bold/i : /^(regular|normal|book|roman)$/i;
  const pick = list.find((f) => want.test(f.style)) ?? list.find((f) => /^(regular|normal)$/i.test(f.style)) ?? list[0];
  return [pick];
}
