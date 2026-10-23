import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..', '..');

// Carrega .env (se existir) sem depender de bibliotecas externas.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const dataDir = path.resolve(process.env.ORBIT_DATA_DIR ?? path.join(root, 'data'));

export const config = {
  root,
  dataDir,
  dbFile: path.join(dataDir, 'orbit.db'),
  storageDir: path.join(dataDir, 'storage'),
  tmpDir: path.join(dataDir, 'tmp'),
  modelsDir: path.resolve(process.env.ORBIT_MODELS_DIR ?? path.join(root, 'data', 'models')),
  secretsFile: path.join(dataDir, 'secrets.json'),
  webDist: path.join(root, 'dist'),
  host: process.env.ORBIT_HOST ?? '127.0.0.1',
  port: Number(process.env.ORBIT_PORT ?? 4310),
  ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
  maxUploadBytes: 20 * 1024 ** 3,
};

for (const d of [config.dataDir, config.storageDir, config.tmpDir, config.modelsDir]) fs.mkdirSync(d, { recursive: true });
