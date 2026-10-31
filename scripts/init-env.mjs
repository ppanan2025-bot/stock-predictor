#!/usr/bin/env node
// Creates/extends <root>/.env from .env.example. `change_me` -> random 24-char secret, `change_me_hex64` -> 32 random bytes hex.
// Never overwrites a key that already exists in .env; only appends missing keys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.SP_ENV_FILE || path.join(root, '.env');
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

const secret = () => crypto.randomBytes(18).toString('base64url').slice(0, 24);
const fill = (v) => (v === 'change_me_hex64' ? crypto.randomBytes(32).toString('hex') : v === 'change_me' ? secret() : v);

const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => l.slice(0, l.indexOf('=')).trim()));

const add = [];
for (const raw of example.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const key = line.slice(0, line.indexOf('=')).trim();
  if (have.has(key)) continue;
  add.push(`${key}=${fill(line.slice(line.indexOf('=') + 1).trim())}`);
}
if (!add.length) { console.error('[init-env] .env complete; leaving it unchanged'); process.exit(0); }
const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
fs.writeFileSync(envPath, existing + prefix + add.join('\n') + '\n', { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
console.error(`[init-env] ${existing ? 'added' : 'wrote'} ${add.length} key(s) to .env: ${add.map((l) => l.split('=')[0]).join(', ')}`);
