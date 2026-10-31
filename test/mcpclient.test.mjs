// Unit: the MCP child environment (Validator P1 #6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv } from '../src/lib/mcpClient.mjs';

test('Validator P1 #6: only SP_* keys come from .env; MYSQL_ROOT_PASSWORD never reaches the MCP child', () => {
  const env = childEnv('/x', { CRAWL_MODE: 'fixture' }, {
    dotEnv: { MYSQL_ROOT_PASSWORD: 'root-secret', SP_APP_PASSWORD: 'app', SP_RO_USER: 'ro', OTHER: 'x' },
    processEnv: { PATH: '/bin', MYSQL_ROOT_PASSWORD: 'exported', SP_RO_USER: 'ro2' },
  });
  assert.equal(env.MYSQL_ROOT_PASSWORD, undefined);
  assert.equal(env.OTHER, undefined);
  assert.equal(env.SP_APP_PASSWORD, undefined); // Phase 2 #2: no password reaches the child's exec env (ps eww)
  assert.equal(env.SP_RO_USER, 'ro2'); // the real process env wins over .env
  assert.equal(env.CRAWL_MODE, 'fixture');
  assert.equal(env.PATH, '/bin');
});

test('Validator Phase 2 #2: no *PASSWORD* key reaches the MCP child, not even from explicit overrides; SP_ENV_FILE only for test.env', async () => {
  const env = childEnv('/x', { SP_APP_PASSWORD: 'o', SP_RO_PASSWORD: 'o', SP_ENV_FILE: '/p/test/db/test.env' }, {
    dotEnv: { SP_APP_PASSWORD: 'a', SP_RO_PASSWORD: 'r', SP_HTTP_UA: 'ua' }, processEnv: { MYSQL_PWD: 'x', my_password: 'y' } });
  assert.deepEqual(Object.keys(env).filter((k) => /password|pwd/i.test(k)), []);
  assert.equal(env.SP_ENV_FILE, '/p/test/db/test.env');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['-e', "import('./src/lib/env.mjs')"], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
    env: { PATH: process.env.PATH, SP_ENV_FILE: '/tmp/evil.env' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SP_ENV_FILE may only point to/);
});
