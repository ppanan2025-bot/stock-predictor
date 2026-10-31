// Read-only SQL guard. Conservative: rejects anything that is not a single read statement.
export class SqlGuardError extends Error {
  constructor(reason) { super(`SQL rejected: ${reason}`); this.name = 'SqlGuardError'; this.reason = reason; }
}

export const MAX_SQL_LENGTH = 10000;
// Used by run_readonly_sql (stock_ro). Copied from news-collection-agent conventions.

const FORBIDDEN_WORDS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE',
  'RENAME', 'CALL', 'DO', 'HANDLER', 'LOAD', 'SET', 'LOCK', 'UNLOCK', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'OUTFILE', 'DUMPFILE', 'INTO'];
const FORBIDDEN_PHRASES = [/\bFOR\s+UPDATE\b/i, /\bFOR\s+SHARE\b/i, /\bSHARE\s+MODE\b/i];
const FORBIDDEN_FUNCS = ['SLEEP', 'BENCHMARK', 'LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'IS_FREE_LOCK', 'IS_USED_LOCK',
  'SYS_EXEC', 'SYS_EVAL', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET', 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS'];
const EXPLAIN_KEYWORDS = new Set(['ANALYZE', 'FORMAT', 'FOR', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TABLE', 'CONNECTION', 'EXTENDED',
  'PARTITIONS', 'INTO', 'SET', 'CALL', 'DO', 'VALUES']);
const FIRST_OK = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);

/** Removes comments and replaces string literals / backtick identifiers with placeholders (single pass). */
export function sanitizeSql(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    // MySQL: "--" starts a comment only when followed by whitespace/control char (or end of input); "1 --1" is arithmetic.
    if (c === '-' && d === '-' && (i + 2 >= n || sql.charCodeAt(i + 2) <= 32)) {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '#') { while (i < n && sql[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new SqlGuardError('unterminated comment');
      i = end + 2; out += ' '; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; const start = ++i;
      let closed = false;
      while (i < n) {
        if (sql[i] === '\\' && q !== '`') { i += 2; continue; }
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; } // doubled quote escape
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw new SqlGuardError('unterminated string or identifier');
      if (q === '`') {
        // BUG-007: MySQL resolves `SLEEP`(1) as the built-in, so a quoted identifier that names a forbidden function is kept
        // as its bare name (whitespace/case normalised) and the function checks below see it.
        const ident = sql.slice(start, i - 1).replaceAll('``', '`').trim().toUpperCase();
        out += FORBIDDEN_FUNCS.includes(ident) ? ` ${ident} ` : '`_id_`';
      } else out += "'_str_'";
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function assertReadOnlySql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') throw new SqlGuardError('empty query');
  if (sql.length > MAX_SQL_LENGTH) throw new SqlGuardError(`query longer than ${MAX_SQL_LENGTH} characters`);
  if (/\/\*[!+]/.test(sql)) throw new SqlGuardError('executable comments and optimizer hints (/*! or /*+) are not allowed');
  let s = sanitizeSql(sql).trim();
  if (s.endsWith(';')) s = s.slice(0, -1).trim();
  if (s.includes(';')) throw new SqlGuardError('only a single statement is allowed');
  if (!s) throw new SqlGuardError('empty query');
  const words = s.match(/[A-Za-z_]+/g) || [];
  const first = (words[0] || '').toUpperCase();
  if (!FIRST_OK.has(first)) throw new SqlGuardError(`statement must start with SELECT, WITH, SHOW, DESCRIBE or EXPLAIN (got ${first || 'nothing'})`);
  // EXPLAIN, DESCRIBE and DESC are synonyms in MySQL (Validator P1 #3): `DESC ANALYZE <stmt>` / `DESCRIBE FORMAT=... <stmt>` run
  // or explain arbitrary statements. EXPLAIN must be followed by SELECT/WITH; DESC/DESCRIBE by SELECT/WITH or a plain table name.
  if (['EXPLAIN', 'DESCRIBE', 'DESC'].includes(first)) {
    const second = (words[1] || '').toUpperCase();
    const isQuery = second === 'SELECT' || second === 'WITH';
    const tableForm = first !== 'EXPLAIN' && !!second && !EXPLAIN_KEYWORDS.has(second) && !/^\s*\w+\s*\(/.test(s.slice(s.search(/\s/)));
    if (!isQuery && !tableForm) throw new SqlGuardError(`${first} must be followed by SELECT or WITH${first === 'EXPLAIN' ? '' : ' (or a table name)'}`);
  }
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(s)) throw new SqlGuardError(`forbidden keyword ${w}`);
  }
  for (const re of FORBIDDEN_PHRASES) if (re.test(s)) throw new SqlGuardError(`locking clause not allowed (${re.source.replace(/\\[bs+]/g, ' ').trim()})`);
  for (const f of FORBIDDEN_FUNCS) {
    if (new RegExp(`\\b${f}\\s*\\(`, 'i').test(s) || new RegExp(`\\b${f}\\b`, 'i').test(s)) throw new SqlGuardError(`forbidden function ${f}`);
  }
  return true;
}
