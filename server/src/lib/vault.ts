// Criptografia local dos tokens das redes (AES-256-GCM). A chave fica em data/secrets.json.
import crypto from 'node:crypto';
import { readSecrets, setSecret } from '../ai/providers.ts';

function key(): Buffer {
  let k = readSecrets().TOKEN_KEY;
  if (!k) {
    k = crypto.randomBytes(32).toString('base64');
    setSecret('TOKEN_KEY', k);
  }
  return Buffer.from(k, 'base64');
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
