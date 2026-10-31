// Shared zod schemas and the MCP tool list (PLAN §3). Used by the server, hooks, settings and tests.
import { z } from 'zod';

export const Ticker = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/, 'ticker: upper-case symbol');
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month: YYYY-MM');
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date: YYYY-MM-DD');
export const Id = z.number().int().positive();

/** Read tools (readOnlyHint). get_research_pack (Phase 3) only appends an immutable snapshot row to research_packs. */
export const READ_TOOLS = ['stats', 'list_companies', 'price_history', 'get_features', 'search_resources', 'get_source',
  'get_research_pack', 'get_consensus', 'get_prediction', 'list_predictions', 'run_status', 'run_readonly_sql'];
/** Planned read tools not yet implemented. */
export const PLANNED_READ_TOOLS = [];
/** Write tools (Phase 2-4). */
export const WRITE_TOOLS = ['ingest_price', 'add_source', 'add_news_item', 'add_research_note', 'recheck_sources', 'compute_features',
  'start_run', 'update_agent_task', 'save_analysis', 'save_prediction', 'save_review', 'finalize_report', 'withdraw_prediction', 'score_outcomes'];
/** Write tools implemented in Phase 2 (ingest and verification). */
export const PHASE2_WRITE_TOOLS = ['ingest_price', 'add_source', 'add_news_item', 'recheck_sources'];
/** Write tools implemented in Phase 3 (research notes and features). */
export const PHASE3_WRITE_TOOLS = ['add_research_note', 'compute_features'];
/** Write tools implemented in Phase 4 (runtime agent workflow, predictions, validation, scoring). */
export const PHASE4_WRITE_TOOLS = ['start_run', 'update_agent_task', 'save_analysis', 'save_prediction', 'save_review', 'finalize_report',
  'withdraw_prediction', 'score_outcomes'];
export const IMPLEMENTED_WRITE_TOOLS = [...PHASE2_WRITE_TOOLS, ...PHASE3_WRITE_TOOLS, ...PHASE4_WRITE_TOOLS];
/** Tools the server registers right now. */
export const TOOL_NAMES = [...READ_TOOLS, ...IMPLEMENTED_WRITE_TOOLS];

// ---------- write-tool inputs (shared by the server, the hooks and the inbox parser) ----------
export const Close = z.union([z.number().positive().finite(), z.string().trim().regex(/^\$?\d{1,7}(\.\d{1,4})?$/, 'close: positive decimal, at most 4 decimals')])
  .transform((v) => String(v).replace('$', ''));
export const Origin = z.enum(['inbox', 'ria_import', 'backfill', 'claude']);
const HttpUrl = z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), 'url: http(s) only');
/** 'YYYY-MM-DD' or an ISO date-time with an explicit offset/Z. */
export const PublishedAt = z.string().trim().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)), 'published_at: YYYY-MM-DD or ISO date-time with offset')
  .refine((v) => Number.isFinite(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)), 'published_at: not a real date');

export const IngestPriceInput = {
  ticker: Ticker, month: Month, trade_date: DateStr, close: Close, origin: Origin.default('claude'),
  inbox_file: z.string().max(255).optional(), submitted_source_url: HttpUrl.optional(),
};
export const SourceKind = z.enum(['news', 'filing', 'ir', 'data', 'reference', 'research']);
export const AddSourceInput = { url: HttpUrl, kind: SourceKind.default('news'), ticker: Ticker.optional() };
/** A reference listed with a news report. Without a url it is recorded only and never counts toward corroboration. */
export const NewsReference = z.object({ url: HttpUrl.optional().nullable(), title: z.string().max(500).optional().nullable() });
export const AddNewsItemInput = {
  ticker: Ticker.nullable().optional(), scope: z.enum(['company', 'macro']).optional(),
  url: HttpUrl, title: z.string().trim().min(3).max(500), published_at: PublishedAt,
  outlet: z.string().max(120).optional().nullable(), author: z.string().max(200).optional().nullable(), summary: z.string().max(5000).optional().nullable(),
  references: z.array(NewsReference).max(20).optional(), inbox_file: z.string().max(255).optional(),
};
export const RecheckSourcesInput = {
  source_ids: z.array(Id).min(1).max(50).optional(), ticker: Ticker.optional(), older_than_days: z.number().int().min(0).max(3650).optional(),
  limit: z.number().int().min(1).max(50).default(25),
  reevaluate_corroboration: z.boolean().optional(),
};

export const NoteCategory = z.enum(['earnings', 'guidance', 'product', 'legal', 'regulatory', 'macro', 'management', 'capital_return', 'supply_chain', 'other']);
/**
 * add_research_note. `excerpt` is optional at the transport level ON PURPOSE: a missing excerpt must reach the server (and the
 * hook) and be rejected with the explicit reason code excerpt_missing, not a generic input error. Length rules (40-1200 after
 * normalisation) are enforced by src/verify/excerpt.mjs from config/verification.json.
 */
export const AddResearchNoteInput = {
  ticker: Ticker, url: HttpUrl,
  excerpt: z.string().max(20000).optional().nullable(),
  claim: z.string().trim().min(10).max(500),
  category: NoteCategory,
  as_of_date: DateStr.optional(),
  kind: z.enum(['filing', 'ir', 'news', 'research', 'reference', 'data']).optional(),
};
export const ComputeFeaturesInput = { ticker: Ticker.optional(), month: Month.optional() };
/** as_of (alias as_of_month): only data dated <= the end of that month is used. pack_id: return that stored snapshot instead. */
export const GetResearchPackInput = { ticker: Ticker, as_of_month: Month.optional(), as_of: Month.optional(), pack_id: Id.optional() };

// ---------- Phase 4: runtime agents ----------
export const Analyzer = z.enum(['fundamental', 'technical', 'news_sentiment', 'macro_sector', 'risk_skeptic']);
export const AgentRole = z.enum(['planner', 'fundamental', 'technical', 'news_sentiment', 'macro_sector', 'risk_skeptic', 'validator',
  'reporter_designer', 'drawer', 'project_manager']);
export const Direction = z.enum(['up', 'down', 'flat']);
export const Ret = z.number().finite().min(-0.99).max(5);
export const ReportPath = z.string().regex(/^reports\/\d{4}-(0[1-9]|1[0-2])\/[A-Z][A-Z0-9.]{0,9}-prediction\.md$/, 'report_path: reports/<YYYY-MM>/<TICKER>-prediction.md');
export const StartRunInput = {
  target_month: Month,
  tickers: z.array(Ticker).min(1).max(10),
  analyzers: z.array(Analyzer).min(3).max(5).optional(),
  missing_resources: z.array(z.object({ ticker: Ticker.nullable().optional(), kind: z.string().max(60), detail: z.string().max(500) })).max(50).optional(),
  notes: z.string().max(2000).optional(),
};
export const UpdateAgentTaskInput = {
  task_id: Id,
  agent: AgentRole,   // must be the task's own agent
  token: z.string().regex(/^[0-9a-f]{32}$/, 'token: the task_token start_run issued for this task'),
  status: z.enum(['running', 'done', 'failed']),
  output_ref: z.string().max(500).optional(),
  error: z.string().max(2000).optional(),
};
export const SaveAnalysisInput = {
  run_id: Id, agent: Analyzer, ticker: Ticker,
  direction: Direction, exp_return_lo: Ret, exp_return_hi: Ret,
  confidence: z.number().min(0).max(1),
  evidence_source_ids: z.array(Id).max(30),
  /** Pack-level evidence (technical/macro_sector): 'prices', 'baseline', 'peers' or 'features.<key>' of THIS run's pack. */
  evidence_pack_fields: z.array(z.string().regex(/^(prices|baseline|peers|features\.[a-z0-9_]+)$/)).max(20).optional(),
  rationale: z.string().trim().min(1).max(4000),
};
export const Issue = z.object({ severity: z.enum(['critical', 'major', 'minor']), section: z.string().max(80).optional(), text: z.string().min(1).max(1000),
  evidence_source_ids: z.array(Id).max(20).optional() });
/** Validator verdict on ONE analysis (analysis_id) or on a saved prediction's report+chart (prediction_id + report_sha256). */
export const SaveReviewInput = {
  perspective: z.literal('validator').default('validator'),
  analysis_id: Id.optional(),
  prediction_id: Id.optional(),
  report_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  verdict: z.enum(['pass', 'pass_with_issues', 'fail']),
  score: z.number().int().min(1).max(5).optional(),
  direction_view: z.enum(['up', 'down', 'flat', 'abstain']).optional(),
  confidence_adj: z.number().min(-0.3).max(0.1).optional(),
  issues: z.array(Issue).max(30).default([]),
  summary: z.string().trim().min(1).max(2000),
};
export const SavePredictionInput = { run_id: Id, ticker: Ticker, report_path: ReportPath };
export const FinalizeReportInput = { prediction_id: Id };
export const WithdrawPredictionInput = { prediction_id: Id, reason: z.string().trim().min(5).max(500) };
export const ScoreOutcomesInput = { ticker: Ticker.optional() };
export const GetConsensusInput = { run_id: Id, ticker: Ticker };
export const SaveAnalysisSchema = z.object(SaveAnalysisInput).strict();

/** Whole-object schemas (hooks and the inbox parser validate complete payloads). */
export const AddResearchNoteSchema = z.object(AddResearchNoteInput).strict();
export const IngestPriceSchema = z.object(IngestPriceInput);
export const AddSourceSchema = z.object(AddSourceInput);
export const AddNewsItemSchema = z.object(AddNewsItemInput).superRefine((v, ctx) => {
  const scope = v.scope ?? (v.ticker ? 'company' : null);
  if (!scope) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'company news needs a ticker; world/market news needs scope "macro"' });
  if (scope === 'company' && !v.ticker) ctx.addIssue({ code: 'custom', path: ['ticker'], message: 'scope company needs a ticker' });
});
export const RecheckSourcesSchema = z.object(RecheckSourcesInput);

/** Inbox price row (csv/json): ticker,month,trade_date,close[,source_url]. Unknown columns are ignored. */
export const InboxPriceRow = z.object({ ticker: Ticker, month: Month, trade_date: DateStr, close: Close, source_url: HttpUrl.optional().or(z.literal('').transform(() => undefined)) });
/** Inbox news item; extra fields (author, note, ...) are accepted and ignored by verification. */
export const InboxNewsItem = AddNewsItemSchema;
export const mcpName = (t) => `mcp__stockdb__${t}`;
