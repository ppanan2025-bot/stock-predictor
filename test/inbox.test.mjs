// Unit (no DB): inbox parsing (PLAN §7) on COPIES of the real inbox files (test/fixtures/inbox/real) and the acceptance inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listInboxFiles, parseInboxFile, parseFrontMatter, splitCsvLine, parsePriceText } from '../src/ingest/inbox.mjs';
import { parseRiaReport } from '../src/ingest/importers/ria-report.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/inbox');

test('real inbox copy: 103 price rows (incl. SPCX from 2026-06), 12 macro + 4 AAPL news; leads/ ignored', () => {
  const files = listInboxFiles(path.join(FX, 'real'));
  assert.deepEqual(files.map((f) => path.relative(path.join(FX, 'real'), f.file)).sort(),
    ['news/company-AAPL-2026-10.json', 'news/world-2026-10-27.json', 'prices/ria-month-end-2024-01_2026-09.csv']);
  const by = Object.fromEntries(files.map((f) => [path.basename(f.file), parseInboxFile(f)]));
  const prices = by['ria-month-end-2024-01_2026-09.csv'];
  assert.equal(prices.fatal, null);
  assert.equal(prices.errors.length, 0);
  assert.equal(prices.items.length, 103);
  assert.deepEqual(prices.items.filter((i) => i.data.ticker === 'SPCX').map((i) => i.data.month), ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(prices.items[0].data.source_url, undefined);
  const world = by['world-2026-10-27.json'];
  assert.equal(world.errors.length, 0);
  assert.equal(world.items.length, 12);
  for (const it of world.items) { assert.equal(it.data.ticker, null); assert.equal(it.data.scope, 'macro'); assert.ok(it.data.references.every((r) => !r.url)); }
  assert.equal(world.items[0].data.note, undefined); // unknown extra fields are dropped
  assert.equal(world.items[0].data.author, 'Catherine Osborn');
  const aapl = by['company-AAPL-2026-10.json'];
  assert.equal(aapl.items.length, 4);
  assert.equal(aapl.items[0].data.references.length, 3);
  assert.ok(aapl.items.every((i) => i.data.ticker === 'AAPL' && i.data.summary));
  assert.throws(() => listInboxFiles(path.join(FX, 'real'), { only: path.join(FX, 'real/leads/2026-10-news-collector-leads.md') }), /never ingested/);
});

test('acceptance inbox: schema errors are row-level; a broken JSON file is fatal; md front-matter with references', () => {
  const files = listInboxFiles(path.join(FX, 'accept'));
  const by = Object.fromEntries(files.map((f) => [path.basename(f.file), parseInboxFile(f)]));
  assert.equal(by['2026-q3.csv'].items.length, 5);
  assert.equal(by['2026-q3.csv'].errors.length, 1); // lower-case ticker
  assert.equal(by['2026-q3.csv'].errors[0].line, 7);
  assert.equal(by['recall.json'].items.length, 6);
  assert.match(by['recall.json'].errors[0].message, /scope/);
  assert.match(by['broken.json'].fatal, /invalid JSON/);
  const md = by['nodate.md'];
  assert.equal(md.items[0].data.references[0].url, 'https://reuters.com/technology/apple-recalls-iphone-duo-chargers-2026-10-20');
  assert.match(md.items[0].data.summary, /TechCrunch says/);
});

test('csv/front-matter helpers and header validation', () => {
  assert.deepEqual(splitCsvLine('a,"b,c","d""e",'), ['a', 'b,c', 'd"e', '']);
  assert.match(parsePriceText('symbol,close\nAAPL,1', '.csv').fatal, /header/);
  assert.equal(parsePriceText('# comment\nticker,month,trade_date,close\nAAPL,2026-09,2026-09-30,$333.02\n', '.csv').items[0].data.close, '333.02');
  assert.throws(() => parseFrontMatter('no front matter'), /front-matter/);
  assert.deepEqual(parseFrontMatter('---\na: "x: y"\nb: null\n---\nbody').data, { a: 'x: y', b: null });
});

test('RIA importer parses the generated price-chart table and skips pre-listing cells', () => {
  const md = `# x\n\n| Month | GOOGL close · trade date | SPCX close · trade date |\n|---|---:|---:|\n| 2026-05 | $1,140.10 · 2026-05-29 | — pre-listing |\n| 2026-06 | $357.37 · 2026-06-30 | $170.86 · 2026-06-30 |\n`;
  const r = parseRiaReport(md);
  assert.equal(r.items.length, 3);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.items[0].data, { ticker: 'GOOGL', month: '2026-05', trade_date: '2026-05-29', close: '1140.10' });
});
