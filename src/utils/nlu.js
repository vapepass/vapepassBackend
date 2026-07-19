/**
 * Lightweight NLU helpers for funnel option matching.
 * Does not change recommendation ranking APIs — only normalizes user text vs labels.
 */

const STOP = new Set([
  'a', 'an', 'the', 'i', 'im', 'want', 'looking', 'for', 'like', 'love', 'prefer',
  'please', 'something', 'with', 'without', 'and', 'or', 'to', 'of', 'in', 'on',
  'get', 'need', 'would', 'can', 'you', 'your', 'this', 'that', 'have', 'just',
]);

export function foldText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function normalizeText(value) {
  let t = foldText(value)
    .replace(/flavour/g, 'flavor')
    .replace(/[^a-z0-9+\s'-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  t = t
    .replace(/\be\s*liquids?\b/g, ' eliquid ')
    .replace(/\beliquids?\b/g, ' eliquid ')
    .replace(/\be\s*juices?\b/g, ' eliquid ')
    .replace(/\bvape\s*juices?\b/g, ' eliquid ')
    .replace(/\bdisposables?\b/g, ' disposable ')
    .replace(/\bpod\s*systems?\b/g, ' pod ')
    .replace(/\bpod\s*kits?\b/g, ' pod ')
    .replace(/\bheavy\s+ice\b/g, ' heavyice ')
    .replace(/\bextra\s+ice\b/g, ' heavyice ')
    .replace(/\bmango[\s-]?ish\b/g, ' mango ')
    .replace(/\btropical\s+fruits?\b/g, ' tropical ')
    .replace(/\btropical\s+flavou?rs?\b/g, ' tropical ')
    .replace(/\bfruit(?:y|s)?\s+flavou?rs?\b/g, ' fruity ')
    .replace(/\bmenthol\s+flavou?rs?\b/g, ' menthol ')
    .replace(/\bminty\b/g, ' mint ')
    .replace(/\bicy\b/g, ' ice ')
    .replace(/\biced\b/g, ' ice ')
    .replace(/\bcooling\b/g, ' ice ')
    .replace(/\s+/g, ' ')
    .trim();

  return t;
}

export function stemToken(token) {
  let t = String(token || '').toLowerCase();
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith('oes') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) {
    t = t.slice(0, -1);
  }
  return t;
}

export function matchKey(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(stemToken)
    .join('');
}

export function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const rows = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let j = 1; j <= t.length; j += 1) {
    let prev = j - 1;
    rows[0] = j;
    for (let i = 1; i <= s.length; i += 1) {
      const cur = rows[i];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      rows[i] = Math.min(rows[i] + 1, rows[i - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return rows[s.length];
}

export function fuzzyMatchKeys(a, b) {
  const ka = matchKey(a);
  const kb = matchKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.includes(kb) || kb.includes(ka)) {
    return Math.min(ka.length, kb.length) >= 4;
  }
  const maxLen = Math.max(ka.length, kb.length);
  if (maxLen <= 3) return false;
  return editDistance(ka, kb) <= (maxLen <= 5 ? 1 : 2);
}

/**
 * Score option label against user message (higher = better).
 */
export function scoreLabelMatch(userMessage, label) {
  const msg = normalizeText(userMessage);
  const lab = normalizeText(label);
  if (!msg || !lab) return 0;

  const mk = matchKey(msg);
  const lk = matchKey(label);
  let score = 0;
  if (mk === lk) score += 100;
  else if (mk.includes(lk) || lk.includes(mk)) score += 70;
  else if (fuzzyMatchKeys(msg, label)) score += 55;

  const msgTokens = msg.split(/\s+/).filter((t) => t && !STOP.has(t)).map(stemToken);
  const labTokens = lab.split(/\s+/).filter((t) => t && !STOP.has(t)).map(stemToken);
  const labSet = new Set(labTokens);
  let hits = 0;
  for (const t of msgTokens) {
    if (labSet.has(t)) hits += 1;
    else if ([...labSet].some((lt) => fuzzyMatchKeys(t, lt))) hits += 0.7;
  }
  if (labTokens.length) score += (hits / labTokens.length) * 40;

  return score;
}
