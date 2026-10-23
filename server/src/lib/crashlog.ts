// Nunca derruba o servidor por um erro solto: registra em data/logs/erros.log e segue rodando.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

const dir = path.join(config.dataDir, 'logs');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'erros.log');

export function logError(kind: string, e: unknown) {
  const msg = `[${new Date().toISOString()}] ${kind}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`;
  try {
    // Mantém o arquivo pequeno (último ~1 MB).
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-500_000));
    fs.appendFileSync(file, msg);
  } catch {
    /* sem disco: só no console */
  }
  console.error(msg);
}

process.on('unhandledRejection', (e) => logError('Promessa sem tratamento', e));
process.on('uncaughtException', (e) => logError('Erro não tratado', e));
