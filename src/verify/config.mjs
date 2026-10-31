// Loads and validates config/verification.json and config/domain-policy.json. Throws (fail closed) on a missing or
// malformed file. Pattern ported from RIA src/verify/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { root } from '../lib/env.mjs';
import { parsePrice } from '../crawl/parse.mjs';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const VerificationSchema = z.object({
  price: z.object({
    tolerance_abs: z.number().min(0).max(1),
    submitted_tolerance_abs: z.number().min(0).max(1),
    required_sources: z.array(z.string()).min(2),
    canonical_source: z.enum(['nasdaq', 'cnbc']),
    cnbc_basis: z.enum(['adjusted', 'unadjusted']),
    reject_zero_volume: z.boolean(),
    settle_minutes_after_close: z.number().int().min(0).max(24 * 60),
    stale_grace_trading_days: z.number().int().min(0).max(10),
    extra_closures: z.array(DateStr),
  }).passthrough(),
  news: z.object({
    title_similarity_min: z.number().min(0).max(1),
    date_tolerance_hours: z.number().min(0),
    min_text_len: z.number().int().min(1),
    fetch: z.object({ timeout_ms: z.number().int().min(1000), max_bytes: z.number().int().min(10000), max_redirects: z.number().int().min(0).max(10) }),
    ticker_aliases: z.record(z.array(z.string().min(2))),
    corroboration: z.object({
      window_hours: z.number().min(1), min_score: z.number().min(0).max(1), min_shared_salient_tokens: z.number().int().min(0),
      relaxed_min_score: z.number().min(0).max(1).optional(), body_keyword_top: z.number().int().min(5).max(100).optional(),
      body_keyword_jaccard_min: z.number().min(0).max(1).optional(),
      min_independent_outlets: z.number().int().min(1), syndication_threshold: z.number().min(0).max(1),
    }),
  }).passthrough(),
}).passthrough();

const OutletSchema = z.object({
  key: z.string().min(1), name: z.string().min(1), domains: z.array(z.string().min(3)).min(1),
  ownership_group: z.string().min(1), tier: z.enum(['primary', 'high', 'standard']),
});
const PolicySchema = z.object({
  https_only: z.boolean(),
  deny: z.array(z.string().min(3)),
  paywall: z.array(z.string().min(3)),
  outlets: z.array(OutletSchema).min(1),
}).passthrough();

/** Parsed verification config plus derived price tolerances in 1/10000-dollar units. */
export function normalizeVerification(raw) {
  const cfg = VerificationSchema.parse(raw);
  const p = cfg.price;
  if (!p.required_sources.includes('nasdaq') || !p.required_sources.includes('cnbc')) throw new Error('price.required_sources must include nasdaq and cnbc');
  return {
    ...cfg,
    price: { ...p, toleranceUnits: parsePrice(p.tolerance_abs.toFixed(4)), submittedToleranceUnits: parsePrice(p.submitted_tolerance_abs.toFixed(4)) },
  };
}

export const normalizePolicy = (raw) => PolicySchema.parse(raw);

const readJson = (projectDir, rel) => JSON.parse(fs.readFileSync(path.join(projectDir, rel), 'utf8'));

const cache = new Map();
function cached(key, fresh, fn) {
  if (!fresh && cache.has(key)) return cache.get(key);
  const v = fn();
  cache.set(key, v);
  return v;
}

export function loadVerification({ projectDir = root, fresh = false } = {}) {
  return cached(`v|${projectDir}`, fresh, () => normalizeVerification(readJson(projectDir, 'config/verification.json')));
}

export function loadPolicy({ projectDir = root, fresh = false } = {}) {
  return cached(`p|${projectDir}`, fresh, () => normalizePolicy(readJson(projectDir, 'config/domain-policy.json')));
}

/** config/companies.json (tickers, names, IR domains, listing dates). */
export function loadCompanies({ projectDir = root, fresh = false } = {}) {
  return cached(`c|${projectDir}`, fresh, () => {
    const c = readJson(projectDir, 'config/companies.json');
    if (!Array.isArray(c?.companies) || !c.companies.length) throw new Error('config/companies.json has no companies');
    return c;
  });
}
