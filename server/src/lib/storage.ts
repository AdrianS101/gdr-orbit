// Organização dos arquivos em disco. Cada marca tem sua própria pasta,
// e os originais nunca são alterados.
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.ts';

export type AssetFileKind = 'original' | 'proxy' | 'waveform' | 'filmstrip' | 'poster';

export function brandDir(brandId: string, ...sub: string[]) {
  const d = path.join(config.storageDir, 'brands', brandId, ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function assetPath(brandId: string, assetId: string, kind: AssetFileKind, ext = ''): string {
  switch (kind) {
    case 'original':
      return path.join(brandDir(brandId, 'originals'), assetId + ext);
    case 'proxy':
      return path.join(brandDir(brandId, 'derived'), `${assetId}.proxy.mp4`);
    case 'waveform':
      return path.join(brandDir(brandId, 'derived'), `${assetId}.peaks.bin`);
    case 'filmstrip':
      return path.join(brandDir(brandId, 'derived'), `${assetId}.strip.jpg`);
    case 'poster':
      return path.join(brandDir(brandId, 'derived'), `${assetId}.poster.jpg`);
  }
}

export function exportPath(brandId: string, file: string) {
  return path.join(brandDir(brandId, 'exports'), file);
}

export function safeFileName(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'arquivo';
}

export function jobTmp(jobId: string) {
  const d = path.join(config.tmpDir, jobId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function rmrf(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignora */
  }
}
