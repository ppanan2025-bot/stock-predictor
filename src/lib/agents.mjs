// Runtime agent roster (user-specified). These values are mirrored by the ENUMs in db/init/01-schema.sql
// (agent_tasks.agent, analyses.agent); test/schema.test.mjs keeps them in sync.
export const ANALYZERS = ['fundamental', 'technical', 'news_sentiment', 'macro_sector', 'risk_skeptic'];
export const AGENT_ROLES = ['planner', ...ANALYZERS, 'validator', 'reporter_designer', 'drawer', 'project_manager'];
// Read-only helper agents: a .claude/agents file but NOT a DB role (no agent_tasks row, no ENUM value, no task token).
export const HELPER_AGENTS = ['blocker_reporter'];
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'rejected'];
export const RUN_STATUSES = ['planned', 'running', 'done', 'failed', 'cancelled'];
