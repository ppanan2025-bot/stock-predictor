// Optional importer (PLAN §6 History): parses regular-investor-agent reports/price-chart.md (a generated table) into price
// submissions with origin 'ria_import'. Read-only: RIA's .env and DB are never touched. Every row is re-verified live by
// ingest_price exactly like an inbox row (same not_month_end / A+B checks).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InboxPriceRow } from '../../verify/schemas.mjs';

// Default: sibling checkout next to this project (<parent>/regular-investor-agent); override with --from-ria <file>.
export const DEFAULT_RIA_REPORT = fileURLToPath(new URL('../../../../regular-investor-agent/reports/price-chart.md', import.meta.url));

/** @returns {items:[{index,line,data}], errors:[{line,message,raw}], skipped:number (pre-listing / gap cells)} */
export function parseRiaReport(text) {
  const lines = String(text).split(/\r?\n/);
  const hIdx = lines.findIndex((l) => /^\|\s*Month\s*\|/i.test(l));
  if (hIdx === -1) return { items: [], errors: [], skipped: 0, fatal: 'no "| Month | ..." table found' };
  const tickers = lines[hIdx].split('|').slice(2, -1).map((h) => (/^\s*([A-Z][A-Z0-9.]{0,9})\s+close/.exec(h) ?? [])[1] ?? null);
  const items = [], errors = []; let skipped = 0, n = 0;
  for (let i = hIdx + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    const month = cells[0];
    cells.slice(1).forEach((cell, k) => {
      const ticker = tickers[k];
      const m = /^\$([\d,]+\.\d{1,4})\s*·\s*(\d{4}-\d{2}-\d{2})$/.exec(cell);
      if (!ticker || !m) { skipped++; return; }
      const row = { ticker, month, trade_date: m[2], close: m[1].replaceAll(',', '') };
      const r = InboxPriceRow.safeParse(row);
      if (r.success) items.push({ index: n++, line: i + 1, data: r.data }); else errors.push({ line: i + 1, message: r.error.issues[0]?.message, raw: cell });
    });
  }
  return { items, errors, skipped, fatal: null };
}

export const readRiaReport = (file = DEFAULT_RIA_REPORT) => parseRiaReport(fs.readFileSync(file, 'utf8'));
