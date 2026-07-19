/**
 * Funnel NLU: normalize input, expand flavor concepts, score options,
 * and only clarify when there is genuinely no plausible match.
 */

const STOP = new Set([
  'a', 'an', 'the', 'i', 'im', 'i\'m', 'me', 'my', 'want', 'wanted', 'looking',
  'for', 'like', 'likes', 'love', 'prefer', 'please', 'something', 'some', 'any',
  'with', 'without', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'is', 'are',
  'be', 'get', 'got', 'need', 'needs', 'would', 'could', 'can', 'you', 'your',
  'that', 'this', 'it', 'have', 'has', 'just', 'really', 'very', 'kind', 'type',
  'sort', 'flavor', 'flavors', 'flavour', 'flavours', 'taste', 'tastes', 'vape',
  'vapes', 'profile', 'profiles',
]);

/** Soft colloquial forms → base concept */
const SOFT_FORMS = new Map([
  ['mangoish', 'mango'],
  ['melonish', 'melon'],
  ['berryish', 'berry'],
  ['minty', 'mint'],
  ['fruity', 'fruity'],
  ['citrusy', 'citrus'],
  ['citrusey', 'citrus'],
  ['icy', 'ice'],
  ['iced', 'ice'],
  ['lemony', 'lemon'],
  ['limey', 'lime'],
]);

/**
 * Concept expansions — user tokens map to related inventory/option keywords.
 * Enables lemon → Citrus, fruity → Berry/Tropical/Melon, etc.
 */
const CONCEPT_EXPANSIONS = {
  fruity: ['fruity', 'fruit', 'berry', 'berries', 'tropical', 'citrus', 'melon', 'mango', 'grape', 'peach', 'strawberry', 'apple', 'cherry', 'lemon', 'lime', 'orange', 'watermelon'],
  fruit: ['fruity', 'fruit', 'berry', 'tropical', 'citrus', 'melon', 'mango'],
  fruits: ['fruity', 'fruit', 'berry', 'tropical', 'citrus', 'melon'],
  citrus: ['citrus', 'lemon', 'lime', 'orange', 'grapefruit', 'tangerine', 'lemonade'],
  lemon: ['lemon', 'citrus', 'lemonade', 'lemonlime'],
  lime: ['lime', 'citrus', 'lemonlime'],
  orange: ['orange', 'citrus'],
  grapefruit: ['grapefruit', 'citrus'],
  tropical: ['tropical', 'mango', 'pineapple', 'passion', 'guava', 'coconut', 'papaya', 'kiwi', 'banana', 'fruity'],
  berry: ['berry', 'berries', 'blueberry', 'strawberry', 'raspberry', 'blackberry', 'fruity'],
  berries: ['berry', 'berries', 'blueberry', 'strawberry', 'raspberry', 'fruity'],
  strawberry: ['strawberry', 'berry', 'fruity'],
  blueberry: ['blueberry', 'berry', 'fruity'],
  mango: ['mango', 'tropical', 'fruity'],
  melon: ['melon', 'watermelon', 'honeydew', 'cantaloupe', 'fruity'],
  watermelon: ['watermelon', 'melon', 'fruity'],
  grape: ['grape', 'melon', 'fruity'],
  peach: ['peach', 'stone', 'fruity'],
  dessert: ['dessert', 'custard', 'cream', 'vanilla', 'cake', 'bakery'],
  candy: ['candy', 'gummy', 'sweet'],
  menthol: ['menthol', 'mint', 'cool', 'ice'],
  mint: ['mint', 'minty', 'menthol', 'spearmint', 'peppermint'],
  ice: ['ice', 'iced', 'icy', 'cooling', 'cool', 'frost', 'menthol'],
  cooling: ['ice', 'cool', 'cooling', 'icy'],
  sweet: ['sweet', 'candy', 'dessert'],
  eliquid: ['eliquid', 'eliquids', 'juice'],
  disposable: ['disposable', 'disposables', 'dispo'],
};

const CONFIDENT_MIN = 55;
const LIKELY_MIN = 38;
const AMBIGUOUS_GAP = 10;

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
    .replace(/\btropical\s+fruits?\b/g, ' tropical ')
    .replace(/\btropical\s+flavou?rs?\b/g, ' tropical ')
    .replace(/\bfruit(?:y|s)?\s+flavou?rs?\b/g, ' fruity ')
    .replace(/\bmenthol\s+flavou?rs?\b/g, ' menthol ')
    .replace(/\bcitrus\s+flavou?rs?\b/g, ' citrus ')
    .replace(/\blemon\s+flavou?rs?\b/g, ' lemon ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [from, to] of SOFT_FORMS.entries()) {
    t = t.replace(new RegExp(`\\b${from}\\b`, 'g'), ` ${to} `);
  }

  // Generic *-ish → base stem (melonish → melon) for matching
  t = t.replace(/\b([a-z]{3,})ish\b/g, ' $1 ');

  return t.replace(/\s+/g, ' ').trim();
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

export function contentTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(stemToken)
    .filter(Boolean);
}

export function matchKey(value) {
  return contentTokens(value).join('');
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

export function strongFuzzyMatch(a, b) {
  const ka = matchKey(a) || stemToken(normalizeText(a));
  const kb = matchKey(b) || stemToken(normalizeText(b));
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ratio = Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length);
  if (ratio >= 0.88 && editDistance(ka, kb) <= 1) return true;
  const maxLen = Math.max(ka.length, kb.length);
  if (maxLen >= 4 && maxLen <= 12 && editDistance(ka, kb) === 1 && ratio >= 0.8) return true;
  return false;
}

/** Expand user tokens with related flavor/product concepts */
export function expandConcepts(value) {
  const tokens = contentTokens(value);
  const out = new Set(tokens);
  for (const tok of tokens) {
    const concepts = CONCEPT_EXPANSIONS[tok] || CONCEPT_EXPANSIONS[stemToken(tok)];
    if (concepts) concepts.forEach((c) => out.add(stemToken(c)));
  }
  return out;
}

const SPECIFIC_TO_FAMILY = {
  lemon: 'citrus',
  lime: 'citrus',
  orange: 'citrus',
  grapefruit: 'citrus',
  tangerine: 'citrus',
  strawberry: 'berry',
  blueberry: 'berry',
  raspberry: 'berry',
  blackberry: 'berry',
  mango: 'tropical',
  pineapple: 'tropical',
  passion: 'tropical',
  guava: 'tropical',
  coconut: 'tropical',
  watermelon: 'melon',
  honeydew: 'melon',
  cantaloupe: 'melon',
  melon: 'melon',
  grape: 'grape',
};

function conceptHitScore(userConcepts, labelConcepts, labelTokens) {
  if (!userConcepts.size) return 0;
  let hits = 0;
  for (const uc of userConcepts) {
    if (labelConcepts.has(uc) || labelTokens.includes(uc)) {
      hits += 1;
      continue;
    }
    if (
      [...labelConcepts].some((lc) => strongFuzzyMatch(uc, lc)) ||
      labelTokens.some((lt) => strongFuzzyMatch(uc, lt))
    ) {
      hits += 0.9;
    }
  }
  if (!hits) return 0;
  // Strong family link (lemon↔citrus) should clear the likely/confident bar
  return Math.min(85, 40 + hits * 22);
}

/**
 * Score option label against user message.
 */
export function scoreLabelMatch(userMessage, label) {
  const msg = normalizeText(userMessage);
  const lab = normalizeText(label);
  if (!msg || !lab) return 0;

  const mk = matchKey(msg);
  const lk = matchKey(label);
  const userTokens = contentTokens(userMessage);
  const labelTokens = contentTokens(label);
  const userConcepts = expandConcepts(userMessage);
  const labelConcepts = expandConcepts(label);

  let score = 0;

  if (mk && lk && mk === lk) score += 100;
  else if (strongFuzzyMatch(msg, label)) score += 88;

  // Direct token equality (lemon vs Lemon Ice, Fruity vs fruity)
  for (const ut of userTokens) {
    if (labelTokens.includes(ut)) score += 55;
    else if (labelTokens.some((lt) => strongFuzzyMatch(ut, lt))) score += 48;
    else if (lab.includes(ut) && ut.length >= 4) score += 42;
  }

  score += conceptHitScore(userConcepts, labelConcepts, labelTokens);

  // Prefer specific fruit → family label (lemon→Citrus) over broad "Fruity"
  for (const ut of userTokens) {
    const family = SPECIFIC_TO_FAMILY[ut];
    if (!family) continue;
    if (labelTokens.includes(ut) || labelTokens.includes(family) || lk.includes(family)) {
      score += 45;
    } else if (labelTokens.includes('fruity') || lk === 'fruity') {
      score += 8;
    }
  }

  // Partial key containment only when lengths are close OR user token is full label word
  if (mk && lk && (mk.includes(lk) || lk.includes(mk))) {
    const ratio = Math.min(mk.length, lk.length) / Math.max(mk.length, lk.length);
    if (ratio >= 0.75) score += 45;
    else if (userTokens.some((t) => t === lk || lk.includes(t))) score += 35;
  }

  return score;
}

/**
 * Assess match confidence.
 * Prefer accepting a likely unique match over saying "I didn't understand".
 */
export function assessOptionMatch(userMessage, options = []) {
  const list = Array.isArray(options) ? options : [];
  if (!userMessage || !list.length) {
    return { status: 'unknown', suggestions: list.slice(0, 8) };
  }

  const scored = list
    .map((option) => ({
      option,
      score: Math.max(
        scoreLabelMatch(userMessage, String(option.label || '')),
        scoreLabelMatch(userMessage, `${option.emoji || ''} ${option.label || ''}`.trim())
      ),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const suggestions = scored.slice(0, 8).map((s) => s.option);

  if (!best) {
    return { status: 'unknown', suggestions };
  }

  // Unique clear winner
  if (best.score >= CONFIDENT_MIN) {
    if (second && second.score >= LIKELY_MIN && best.score - second.score < AMBIGUOUS_GAP) {
      // If user named a specific fruit, prefer its family label over broad "Fruity"
      const userTokens = contentTokens(userMessage);
      const specificPick = scored.find((s) => {
        const labTokens = contentTokens(s.option.label);
        const labKey = matchKey(s.option.label);
        return userTokens.some((ut) => {
          const family = SPECIFIC_TO_FAMILY[ut];
          if (!family) return false;
          return (
            labTokens.includes(ut) ||
            labTokens.includes(family) ||
            labKey.includes(family)
          );
        });
      });
      if (specificPick && specificPick.score >= LIKELY_MIN) {
        return {
          status: 'confident',
          option: specificPick.option,
          score: specificPick.score,
          suggestions: [specificPick.option],
        };
      }

      const related = scored.filter((s) => s.score >= LIKELY_MIN).slice(0, 8);
      if (related.length >= 2) {
        return {
          status: 'ambiguous',
          suggestions: related.map((s) => s.option),
          score: best.score,
          likely: best.option,
          reason: 'related',
        };
      }
    }
    return {
      status: 'confident',
      option: best.option,
      score: best.score,
      suggestions: [best.option],
    };
  }

  // Likely single match (e.g. melonish → Melon, lemon → Citrus)
  if (best.score >= LIKELY_MIN) {
    const gap = best.score - (second?.score || 0);
    if (!second || gap >= AMBIGUOUS_GAP || second.score < LIKELY_MIN) {
      return {
        status: 'confident',
        option: best.option,
        score: best.score,
        suggestions: [best.option],
      };
    }
    return {
      status: 'ambiguous',
      suggestions: scored
        .filter((s) => s.score >= LIKELY_MIN - 5)
        .slice(0, 6)
        .map((s) => s.option),
      score: best.score,
      likely: best.option,
      reason: 'close',
    };
  }

  return {
    status: 'unknown',
    suggestions,
    score: best.score,
    likely: best.score >= 20 ? best.option : null,
  };
}

export function isConfidentRefinementPhrase(message) {
  const t = foldText(message);
  return /\b(sweeter|less sweet|more ice|less ice|no ice|heavy ice|extra ice|stronger|milder|smoother|another recommendation|something else|different (one|flavor|option)|no menthol|without menthol)\b/.test(
    t
  );
}

/** Strip frontend enrichment like "menthol (Menthol / Mint)" → "menthol" */
export function sanitizeUserHint(message) {
  return String(message || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the message is a taste/flavor preference rather than a product-type choice.
 * e.g. "menthol", "fruity", "heavy ice", "something sweet"
 */
export function isKnownPreferenceSignal(message) {
  const clean = sanitizeUserHint(message);
  if (!clean) return false;
  const concepts = expandConcepts(clean);
  const pref = new Set([
    'menthol',
    'mint',
    'fruity',
    'fruit',
    'citrus',
    'lemon',
    'lime',
    'tropical',
    'berry',
    'mango',
    'melon',
    'strawberry',
    'ice',
    'sweet',
    'dessert',
    'candy',
    'beverage',
    'cooling',
    'smooth',
  ]);
  if ([...concepts].some((c) => pref.has(c))) return true;
  return /\b(menthol|minty?|fruity|citrus|tropical|berr(?:y|ies)|mango|melon|lemon|lime|ice|iced|icy|sweet|dessert|candy|smooth)\b/i.test(
    clean
  );
}

/** Product-type / inventory-type funnel step (E-Liquids, Disposables, …) */
export function looksLikeProductTypeStep(step) {
  const prompt = String(step?.prompt || '').toLowerCase();
  if (/\b(type of product|product type|what (kind|type) of product|inventory)\b/.test(prompt)) {
    return true;
  }
  const labels = (step?.options || []).map((o) => String(o.label || '').toLowerCase());
  if (!labels.length) return false;
  const typeHits = labels.filter((l) =>
    /\b(e-?liquids?|disposables?|devices?|pods?|kits?|accessor|pouches?|coils?|batter)/i.test(l)
  ).length;
  return typeHits >= 1 && typeHits >= Math.ceil(labels.length * 0.5);
}

/**
 * Acknowledge a valid preference that doesn't answer the current step
 * (e.g. "menthol" while asking for product type) — never "I couldn't match".
 */
export function buildPreferenceAckReply(userMessage, stepOrQuestion, options = []) {
  const clean = sanitizeUserHint(userMessage) || 'that preference';
  const prompt =
    stepOrQuestion?.prompt || 'What type of product are you looking for?';
  const list = (options.length ? options : stepOrQuestion?.options || []).slice(0, 10);
  const labels = list.map((o) => String(o.label || '').trim()).filter(Boolean);

  const lines = [
    `Got it — I'll keep “${clean}” in mind.`,
    '',
    prompt,
  ];
  if (labels.length) {
    lines.push('');
    for (const label of labels) {
      lines.push(`• ${label}`);
    }
  }
  return lines.join('\n');
}

/**
 * Clarification that prefers "Did you mean…?" over "I didn't understand"
 * when a likely option exists.
 */
export function buildClarificationReply(userMessage, stepOrQuestion, options = [], assessment = null) {
  const quoted = sanitizeUserHint(userMessage).slice(0, 48);
  const prompt = stepOrQuestion?.prompt || 'Which option fits best?';
  const list = (options.length ? options : stepOrQuestion?.options || []).slice(0, 10);
  const labels = list.map((o) => String(o.label || '').trim()).filter(Boolean);
  const likelyLabel = assessment?.likely?.label || assessment?.option?.label;

  const lines = [];

  if (assessment?.reason === 'related' && labels.length) {
    lines.push(
      quoted
        ? `Got it — you’re looking for something like “${quoted}”.`
        : 'Got it — that sounds like a flavor preference.'
    );
    lines.push('');
    lines.push('Which of these is closest to what you want?');
  } else if (likelyLabel && assessment?.status !== 'unknown') {
    lines.push(`I think you might mean “${likelyLabel}”. Is that right?`);
    lines.push('');
    lines.push('Or pick one of these:');
  } else if (likelyLabel && assessment?.status === 'unknown') {
    lines.push(
      quoted
        ? `I’m not fully sure about “${quoted}”. Did you mean “${likelyLabel}”?`
        : `Did you mean “${likelyLabel}”?`
    );
    lines.push('');
    lines.push('If not, choose from:');
  } else {
    lines.push(
      quoted
        ? `I couldn’t match “${quoted}” to an available option.`
        : 'I couldn’t match that to an available option.'
    );
    lines.push('');
    lines.push('Please choose one of these:');
  }

  lines.push('');
  lines.push(prompt);

  if (labels.length) {
    lines.push('');
    for (const label of labels) {
      lines.push(`• ${label}`);
    }
  }

  return lines.join('\n');
}
