// Deterministic text utilities: HTML stripping, tokenizing, light stemming, keywords.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(s) {
  return decodeEntities(String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export const STOPWORDS = new Set(`a about above across again against all almost also although always am among an and another any anyone
anything are aren around as at be became because become been before being below between both but by can cannot could
did didn do does doesn doing don done down during each either else even ever every few for from further get gets
got had has hasn have haven having he her here hers herself him himself his how however i if in into is isn it its itself
just least less let like made make many may me might more most much must my myself near neither no nor not now of off
often on once one only or other others our ours ourselves out own per perhaps rather same she should since so some
such than that the their theirs them themselves then there these they this those though through thus to too toward
under until up upon us very via was wasn we were weren what when where whether which while who whom whose why will
with within without would yet you your yours yourself yourselves
says said say live update updates video watch latest news report reports new after amid over`.split(/\s+/).filter(Boolean));

export function normalize(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function stem(t) {
  const n = t.length;
  if (t.endsWith('ies') && n > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('ions') && n > 6) return t.slice(0, -4);
  if (t.endsWith('ion') && n > 5) return t.slice(0, -3);
  if (t.endsWith('ing') && n > 5) return t.slice(0, -3);
  if (t.endsWith('ed') && n > 4) return t.slice(0, -2);
  if (t.endsWith('es') && n > 4) return t.slice(0, -2);
  if (t.endsWith('s') && n > 3 && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

const isNumeric = (t) => /^\d+$/.test(t);

function keep(word) {
  if (!word || STOPWORDS.has(word)) return false;
  if (isNumeric(word)) return word.length >= 2;
  return word.length >= 3;
}

/** Raw words (diacritics stripped, original case kept). */
function words(text) {
  return normalize(text).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

export function tokenize(text) {
  const out = [];
  for (const w of words(text)) {
    const lw = w.toLowerCase();
    if (keep(lw)) out.push(stem(lw));
  }
  return out;
}

/** Salient tokens of a title: stem length >= 5, numeric, or a capitalised (non-first) word. */
export function salientTokens(title) {
  const ws = words(title);
  const out = new Set();
  ws.forEach((w, i) => {
    const lw = w.toLowerCase();
    if (!keep(lw)) return;
    const s = stem(lw);
    if (s.length >= 5 || isNumeric(s) || (i > 0 && /^[A-Z]/.test(w))) out.add(s);
  });
  return out;
}

export function keywords(text, n = 12) {
  const freq = new Map();
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([t]) => t);
}
