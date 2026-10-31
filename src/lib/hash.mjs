// sha256 helpers and a stable JSON serialisation (sorted keys) so hashes of objects are reproducible.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const sha256File = (file) => sha256(fs.readFileSync(file));

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
export const sha256Json = (v) => sha256(stableStringify(v));
