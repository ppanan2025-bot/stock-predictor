// SEC EDGAR fair-access rule: automated requests must declare who is calling (a User-Agent with a contact address). The
// contact is the user's own choice and lives ONLY in the environment (SP_HTTP_UA, written to .env by the user). This module
// never contains or invents one: while SP_HTTP_UA is unset or still the .env.example placeholder, every sec.gov request is
// refused with the reason code `sec_user_agent_unset`.

export const SEC_UA_REASON = 'sec_user_agent_unset';

/** Placeholder fragments (from .env.example and common templates). */
const PLACEHOLDER = /example\.(com|org|net)|set-your|your[-_ ]?(e-?mail|name|address)|change[-_]?me|placeholder|todo|xxx|<[^>]*>|\bemail@|\buser@|\bname@/i;

export const isSecHost = (host) => { const h = String(host ?? '').toLowerCase(); return h === 'sec.gov' || h.endsWith('.sec.gov'); };

/**
 * Why `ua` cannot be used for SEC requests, or null when it can. Live requests additionally need a contact address ('@');
 * fixture (recorded) runs only need a non-placeholder value.
 */
export function secUserAgentProblem(ua, { live = true } = {}) {
  const v = String(ua ?? '').trim();
  if (!v) return 'SP_HTTP_UA is not set. SEC EDGAR requires a User-Agent with your contact e-mail; add it to .env yourself (it is never put in code or config)';
  if (PLACEHOLDER.test(v)) return 'SP_HTTP_UA still holds the placeholder contact from .env.example. Set your own contact e-mail in .env before crawling SEC EDGAR';
  if (v.length < 8 || v.length > 200) return 'SP_HTTP_UA must be 8-200 characters (e.g. "<app name> <contact e-mail>")';
  if (live && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v)) return 'SP_HTTP_UA has no contact e-mail; SEC EDGAR requires one for automated requests';
  return null;
}

export class SecUserAgentError extends Error {
  constructor(message) { super(`${SEC_UA_REASON}: ${message}`); this.name = 'SecUserAgentError'; this.code = SEC_UA_REASON; }
}

/** Throws SecUserAgentError (code sec_user_agent_unset) unless `ua` is usable. Returns the trimmed UA. */
export function requireSecUserAgent(ua, opts = {}) {
  const p = secUserAgentProblem(ua, opts);
  if (p) throw new SecUserAgentError(p);
  return String(ua).trim();
}
