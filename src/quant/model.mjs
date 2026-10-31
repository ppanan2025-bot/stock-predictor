// Loads and validates config/model.json (fail closed on a missing or malformed file).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { root } from '../lib/env.mjs';

const P = z.number().min(0).max(1);
const ModelSchema = z.object({
  baseline: z.object({
    code_version: z.string().min(1),
    weights: z.object({ base_rate: P, momentum: P, mean_reversion: P, prior: P }),
    momentum_slope: z.number(), mean_reversion_slope: z.number(),
    mu_weights: z.object({ mean36: P, momentum: P, mean_reversion: P }),
    mu_momentum_scale: z.number(), mu_mean_reversion_scale: z.number(),
    range_k: z.number().positive().max(5),
    flat_band: z.number().min(0).max(0.2), up_threshold: P, down_threshold: P,
    confidence_max: P, full_data_months: z.number().int().positive(),
  }).passthrough(),
  consensus: z.object({
    min_accepted_analyses: z.number().int().min(1).max(5), baseline_weight: z.number().min(0),
    max_p_adj: z.number().min(0).max(0.15), overlay_max_sigma: z.number().positive(),
    confidence_floor: P, confidence_cap: P, label_thresholds: z.object({ low: P, medium: P }),
  }),
  analysis: z.object({
    min_rationale_chars: z.number().int().min(1), no_evidence_max_confidence: P,
    pack_field_evidence_agents: z.array(z.string()), min_dispatched_single: z.number().int().min(3).max(5), return_bounds: z.tuple([z.number(), z.number()]), max_attempts: z.number().int().min(1),
  }),
  short_history: z.object({ sigma_floor: z.number().positive(), max_confidence: P, min_range_width: z.number().min(0) }),
  validator: z.object({ max_redo_rounds: z.number().int().min(0), confidence_adj_bounds: z.tuple([z.number(), z.number()]) }),
  project_manager: z.object({ stall_minutes: z.number().positive() }),
}).passthrough();

export function normalizeModel(raw) {
  const m = ModelSchema.parse(raw);
  const w = m.baseline.weights;
  if (Math.abs(w.base_rate + w.momentum + w.mean_reversion + w.prior - 1) > 1e-9) throw new Error('model.baseline.weights must sum to 1');
  const mw = m.baseline.mu_weights;
  if (Math.abs(mw.mean36 + mw.momentum + mw.mean_reversion - 1) > 1e-9) throw new Error('model.baseline.mu_weights must sum to 1');
  return m;
}

const cache = new Map();
export function loadModel({ projectDir = root, fresh = false } = {}) {
  if (!fresh && cache.has(projectDir)) return cache.get(projectDir);
  const m = normalizeModel(JSON.parse(fs.readFileSync(path.join(projectDir, 'config/model.json'), 'utf8')));
  cache.set(projectDir, m);
  return m;
}
