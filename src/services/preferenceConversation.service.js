/**
 * Preference-driven shopping conversation — extract intent from free text,
 * ask only for missing parameters, then recommend from inventory.
 */

import {
  contentTokens,
  expandConcepts,
  normalizeText,
  sanitizeUserHint,
  foldText,
  strongFuzzyMatch,
} from '../utils/nlu.js';

const LIQUID_LIKE = new Set(['e_liquid', 'disposable', 'prefilled', 'pouch']);

const TYPE_LABELS = {
  e_liquid: 'E-Liquids',
  disposable: 'Disposable Vapes',
  device: 'Devices & Kits',
  pod: 'Pod Systems',
  prefilled: 'Prefilled Pods',
  accessory: 'Accessories',
  coil: 'Coils',
  cartridge: 'Cartridges',
  battery: 'Batteries',
  pouch: 'Nicotine Pouches',
};

/**
 * Summarize which product families exist in this store's inventory.
 * Only count types that would actually match recommendations (same rules as search).
 */
export function summarizeInventoryOfferings(inventory = []) {
  const found = new Set();
  const list = Array.isArray(inventory) ? inventory : [];
  for (const type of Object.keys(TYPE_LABELS)) {
    if (list.some((p) => matchesProductType(p, type))) found.add(type);
  }
  return [...found];
}

export function buildOpenShoppingPrompt(inventory = [], storeName = null, options = {}) {
  const intro = options.freshRestart
    ? ['Sure! Let’s find another product for you.', '']
    : [];

  const offerings = summarizeInventoryOfferings(inventory)
    .map((t) => TYPE_LABELS[t])
    .filter(Boolean);
  const carry =
    offerings.length > 0
      ? offerings.slice(0, 5).join(', ')
      : 'E-Liquids, Disposables, Devices, Pods, and more';

  return [
    ...intro,
    `What are you looking for today? We carry ${carry}. Just tell me what you're craving—like fruity, icy, or dessert flavors, or a specific brand—and I'll find it for you!`,
  ].join('\n');
}

/**
 * Extract structured shopping preferences from a free-form user message.
 */
export function extractShoppingPreferences(message) {
  const clean = sanitizeUserHint(message);
  const normalized = normalizeText(clean);
  const concepts = expandConcepts(clean);
  const tokens = contentTokens(clean);
  const hasConcept = (c) => concepts.has(c);
  const hasToken = (c) =>
    tokens.includes(c) || new RegExp(`\\b${String(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clean);

  const prefs = {
    productType: null,
    flavorDirection: null,
    specificFlavors: [],
    cooling: null,
    sweetness: null,
    brand: null,
    rawHints: clean ? [clean] : [],
  };

  // Product type — more specific phrases before broad "pods"
  if (hasConcept('eliquid') || /\be[\s-]?liquids?\b|\be[\s-]?juices?\b|\bsalt\s*nic/i.test(clean)) {
    prefs.productType = 'e_liquid';
  } else if (hasConcept('disposable') || /\bdisposables?\b|\bdispo\b/i.test(clean)) {
    prefs.productType = 'disposable';
  } else if (/\bpre-?filled\b/i.test(clean) || /\bprefilled\s*pods?\b/i.test(clean)) {
    prefs.productType = 'prefilled';
  } else if (/\bpod\s*systems?\b/i.test(clean) || hasConcept('pod') || /\bpods?\b/i.test(clean)) {
    prefs.productType = 'pod';
  } else if (
    hasConcept('device') ||
    /\bdevices?\s*(?:&|and)?\s*kits?\b/i.test(clean) ||
    /\b(device|kit|mod|starter)\b/i.test(clean)
  ) {
    prefs.productType = 'device';
  } else if (/\baccessor/i.test(clean) || /\bcoils?\b/i.test(clean)) {
    prefs.productType = 'accessory';
  } else if (/\bpouches?\b/i.test(clean)) {
    prefs.productType = 'pouch';
  }

  // Flavor direction — prefer explicit user words over broad concept expansion
  if (hasToken('citrus') || hasToken('lemon') || hasToken('lime') || hasToken('orange')) {
    prefs.flavorDirection = 'citrus';
  } else if (hasToken('tropical') || hasToken('pineapple') || hasToken('guava')) {
    prefs.flavorDirection = 'tropical';
  } else if (hasToken('berry') || hasToken('berries') || hasToken('strawberry') || hasToken('blueberry') || hasToken('raspberry')) {
    prefs.flavorDirection = 'berry';
  } else if (hasToken('melon') || hasToken('watermelon') || hasToken('grape')) {
    prefs.flavorDirection = 'melon';
  } else if (hasToken('menthol') || hasToken('mint') || hasToken('minty')) {
    prefs.flavorDirection = 'menthol';
    // Do NOT auto-set cooling — always ask ice / no-ice before brand + recommend
  } else if (hasToken('dessert') || hasToken('custard') || hasToken('vanilla') || hasToken('cream')) {
    prefs.flavorDirection = 'dessert';
  } else if (hasToken('candy') || hasToken('gummy')) {
    prefs.flavorDirection = 'candy';
  } else if (
    hasToken('fruity') ||
    hasToken('fruit') ||
    hasToken('fruits') ||
    hasConcept('fruity') ||
    // typo tolerance: fuity, fruty, fruitty, etc.
    [...tokens].some((tok) => strongFuzzyMatch(tok, 'fruity') || strongFuzzyMatch(tok, 'fruit'))
  ) {
    prefs.flavorDirection = 'fruity';
  } else if (hasToken('mango')) {
    prefs.flavorDirection = 'tropical';
  }

  // Specific flavor notes — only words the user actually typed
  const SPECIFICS = [
    'mango',
    'strawberry',
    'blueberry',
    'raspberry',
    'lemon',
    'lime',
    'orange',
    'watermelon',
    'peach',
    'grape',
    'apple',
    'banana',
    'pineapple',
    'coconut',
    'cherry',
    'vanilla',
    'tobacco',
  ];
  for (const flavor of SPECIFICS) {
    if (hasToken(flavor)) prefs.specificFlavors.push(flavor);
  }
  prefs.specificFlavors = [...new Set(prefs.specificFlavors)];

  // Cooling — absolute phrases only; relative "more/less ice" handled in applyRelativePreferenceDeltas
  if (/\b(no ice|without ice|no cooling|not iced|smooth without)\b/i.test(clean)) {
    prefs.cooling = 'no_ice';
  } else if (/\b(heavy ice|extra ice|max ice|ultra ice)\b/i.test(clean)) {
    prefs.cooling = 'heavy_ice';
  } else if (
    hasToken('ice') ||
    hasToken('icy') ||
    hasToken('iced') ||
    hasToken('cooling') ||
    /\b(cool finish|cold finish|frost|chill|with ice)\b/i.test(clean)
  ) {
    // Avoid treating "less ice" / "more ice" as plain ice — those are relative deltas
    if (!/\b(less ice|more ice|less icy|more icy|icier|less cooling|more cooling)\b/i.test(clean)) {
      prefs.cooling = 'ice';
    }
  }

  // Sweetness — relative phrases
  if (/\b(less sweet|not sweet|not too sweet|less sugar|reduce(?:d)? sweet)\b/i.test(clean)) {
    prefs.sweetness = 'less_sweet';
  } else if (
    hasToken('sweet') ||
    /\bsweeter\b/i.test(clean) ||
    /\bmore sweet\b/i.test(clean) ||
    /\bcandy[- ]?like\b/i.test(clean)
  ) {
    prefs.sweetness = 'sweet';
  }

  return prefs;
}

/**
 * Apply relative refine language onto the previous preference pass.
 * Escalates / de-escalates cooling & sweetness and amplifies flavor direction wording.
 */
export function applyRelativePreferenceDeltas(previous = {}, message = '') {
  const clean = sanitizeUserHint(message);
  const extracted = extractShoppingPreferences(clean);
  // Don't let bare "ice" from extract clobber a relative delta we apply below
  if (/\b(less ice|more ice|less icy|more icy|icier|less cooling|more cooling)\b/i.test(clean)) {
    extracted.cooling = null;
  }
  const merged = mergePreferences(previous || emptyPreferences(), extracted);
  const text = String(clean || '').toLowerCase();

  // Cooling ladder: no_ice ↔ ice ↔ heavy_ice
  if (/\b(less ice|less icy|less cooling|reduce(?:d)? ice|not too (?:icy|iced|cold))\b/i.test(text)) {
    if (merged.cooling === 'heavy_ice') merged.cooling = 'ice';
    else merged.cooling = 'no_ice';
  } else if (/\b(more ice|more icy|icier|extra ice|strong(?:er)? (?:ice|cooling)|more cooling)\b/i.test(text)) {
    if (merged.cooling === 'no_ice') merged.cooling = 'ice';
    else merged.cooling = 'heavy_ice';
  }

  // Flavor intensity refine — keep type/cooling, nudge direction
  if (/\bmore fruity\b|\bfruitier\b/i.test(text)) merged.flavorDirection = 'fruity';
  if (/\bmore tropical\b/i.test(text)) merged.flavorDirection = 'tropical';
  if (/\bmore citrus\b/i.test(text)) merged.flavorDirection = 'citrus';
  if (/\bmore (?:candy|gummy)\b|\bcandy[- ]?like\b/i.test(text)) {
    merged.flavorDirection = 'candy';
    if (!merged.sweetness) merged.sweetness = 'sweet';
  }
  if (/\bmore menthol\b|\bmore mint\b/i.test(text)) {
    merged.flavorDirection = 'menthol';
    // Keep existing cooling; do not auto-force ice on refine
  }
  if (/\bmore dessert\b/i.test(text)) merged.flavorDirection = 'dessert';

  if (/\bsweeter\b|\bmore sweet\b/i.test(text)) merged.sweetness = 'sweet';
  if (/\bless sweet\b|\bnot too sweet\b/i.test(text)) merged.sweetness = 'less_sweet';

  if (clean) {
    merged.rawHints = [...new Set([...(merged.rawHints || []), clean].filter(Boolean))].slice(-10);
  }

  return merged;
}

export function mergePreferences(previous = {}, incoming = {}) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const next = { ...prev };

  if (incoming.productType) {
    const typeChanged = incoming.productType !== prev.productType;
    next.productType = incoming.productType;
    if (typeChanged) {
      // Re-ask brand for the new category; drop liquid-only prefs for hardware
      next.brand = incoming.brand || null;
      if (!isLiquidLike(incoming.productType)) {
        next.flavorDirection = null;
        next.specificFlavors = [];
        next.cooling = null;
        next.sweetness = null;
      }
    }
  }
  if (incoming.flavorDirection) next.flavorDirection = incoming.flavorDirection;
  if (incoming.cooling) next.cooling = incoming.cooling;
  if (incoming.sweetness) next.sweetness = incoming.sweetness;
  if (incoming.brand) next.brand = incoming.brand;

  const flavors = [
    ...(Array.isArray(prev.specificFlavors) && isLiquidLike(next.productType || prev.productType)
      ? prev.specificFlavors
      : []),
    ...(Array.isArray(incoming.specificFlavors) ? incoming.specificFlavors : []),
  ];
  next.specificFlavors = [...new Set(flavors)].slice(0, 8);

  const hints = [
    ...(Array.isArray(prev.rawHints) ? prev.rawHints : []),
    ...(Array.isArray(incoming.rawHints) ? incoming.rawHints : []),
  ]
    .map((h) => String(h || '').trim())
    .filter(Boolean);
  next.rawHints = [...new Set(hints)].slice(-10);

  return next;
}

function isLiquidLike(productType) {
  return LIQUID_LIKE.has(productType);
}

/**
 * Decide whether we can recommend, or what single follow-up to ask.
 */
export function evaluatePreferenceCompleteness(prefs = {}, inventory = []) {
  const p = prefs || {};

  if (!p.productType) {
    const types = summarizeInventoryOfferings(inventory);
    const labels = types.map((t) => TYPE_LABELS[t]).filter(Boolean);
    const examples = labels.length
      ? labels.slice(0, 4).join(', ')
      : 'e-liquids, disposables, pods, or accessories';
    return {
      ready: false,
      missing: 'productType',
      ask: `Got it. What type of product do you want — for example ${examples}?`,
    };
  }

  const typePool = (inventory || []).filter((item) => matchesProductType(item, p.productType));
  if (!typePool.length) {
    const label = TYPE_LABELS[p.productType] || p.productType || 'that category';
    return {
      ready: false,
      missing: 'productType',
      ask: `I don't currently have recommendable ${label} in this store's inventory. Want to try a different product type — e-liquids, disposables, pods, or accessories?`,
    };
  }

  const needsFlavor = isLiquidLike(p.productType);
  const hasFlavor =
    Boolean(p.flavorDirection) || (Array.isArray(p.specificFlavors) && p.specificFlavors.length > 0);

  if (needsFlavor && !hasFlavor) {
    return {
      ready: false,
      missing: 'flavor',
      ask: 'What flavor direction do you prefer — fruity, menthol/mint, dessert, candy, or something citrusy? You can also name a fruit like mango or strawberry.',
    };
  }

  if (needsFlavor && p.cooling == null) {
    return {
      ready: false,
      missing: 'cooling',
      ask: 'Would you like it with ice / cooling, or smooth without ice?',
    };
  }

  // Brand preference — REQUIRED before any recommendation (never skip)
  if (p.brand == null || p.brand === '') {
    const examples = listInventoryBrands(inventory, p.productType, 5);
    const ask = examples.length
      ? `Do you have a preferred brand? For example: ${examples.join(', ')}. You can also name another brand in stock, or reply with "No Preference."`
      : `Do you have a preferred brand for this category? If not, simply reply with "No Preference" and I'll pick the best match from what's in stock.`;
    return {
      ready: false,
      missing: 'brand',
      ask,
    };
  }

  // 'any' brand means no brand filter — ready to recommend
  return { ready: true, missing: null, ask: null };
}

const BRAND_NO_PREF_RE =
  /\b(no preference|any brand|any other brand|other brands?|doesn't matter|doesnt matter|dont care|don't care|whatever|surprise me|you (pick|choose)|no brand)\b/i;

/** Flavor / preference words that must never be treated as brand names */
const FLAVOR_NOT_BRAND_RE =
  /\b(fruit|fruity|ice|iced|icy|sweet|sweeter|dessert|candy|gummy|menthol|mint|minty|mango|berry|berries|citrus|tropical|melon|grape|peach|lemon|lime|orange|strawberry|blueberry|vanilla|tobacco|smooth|cooling|disposable|liquid|juice|accessory)\b/i;

/**
 * Top brands in inventory (optionally scoped to a product type).
 */
export function listInventoryBrands(inventory = [], productType = null, limit = 8) {
  const counts = new Map();
  for (const product of inventory) {
    if (productType && !matchesProductType(product, productType)) continue;
    const raw = String(product.brand || '').trim();
    if (!raw || raw.length < 2) continue;
    if (/^(n\/?a|none|unknown|null|undefined)$/i.test(raw)) continue;
    if (FLAVOR_NOT_BRAND_RE.test(foldText(raw))) continue;
    const key = raw.toLowerCase();
    const prev = counts.get(key);
    counts.set(key, { name: prev?.name || raw, n: (prev?.n || 0) + 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => row.name);
}

/**
 * Resolve a brand preference from user text against inventory brands.
 * Only call this when answering the brand question (or an explicit brand phrase).
 * @returns {'any'|string|null} canonical brand name, 'any', or null if unresolved
 */
export function matchBrandPreference(message, inventory = [], productType = null) {
  const clean = sanitizeUserHint(message);
  const text = foldText(clean);
  if (!text) return null;

  if (
    BRAND_NO_PREF_RE.test(text) ||
    /^(no|none|nah|idk|n\/a|any)$/i.test(String(clean || '').trim())
  ) {
    return 'any';
  }

  // Never treat flavor / cooling answers as a brand
  if (FLAVOR_NOT_BRAND_RE.test(text) && !/\bbrand\b/i.test(text)) {
    return null;
  }

  const brands = listInventoryBrands(inventory, productType, 80).filter(
    (b) => !FLAVOR_NOT_BRAND_RE.test(foldText(b))
  );
  const ranked = [...brands].sort((a, b) => b.length - a.length);
  for (const brand of ranked) {
    const folded = foldText(brand);
    if (!folded || folded.length < 2) continue;
    const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (text === folded || new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      return brand;
    }
  }

  // Short free-text answer while answering the brand question — accept as typed brand
  if (clean && clean.length <= 40 && clean.split(/\s+/).length <= 4) {
    if (!FLAVOR_NOT_BRAND_RE.test(clean)) {
      return clean;
    }
  }

  return null;
}

/**
 * True when the user is explicitly naming a brand (not a flavor answer).
 */
export function looksLikeExplicitBrandPhrase(message) {
  const clean = sanitizeUserHint(message);
  if (!clean) return false;
  return /\b(brand|from|by)\s+[a-z0-9]/i.test(clean) || /\b[a-z0-9][a-z0-9 &\-]{1,30}\s+brand\b/i.test(clean);
}

function productHaystack(product) {
  return [
    product.name,
    product.flavor,
    product.variantName,
    product.description,
    product.category,
    product.subcategory,
    product.brand,
    product.productType,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Related catalog types that may satisfy a preference (never cross e-liquid ↔ disposable ↔ device). */
const TYPE_COMPAT = {
  e_liquid: new Set(['e_liquid']),
  disposable: new Set(['disposable']),
  device: new Set(['device']),
  // Pod systems / empty mesh pods — not flavored closed pods
  pod: new Set(['pod']),
  // Flavored closed pods only
  prefilled: new Set(['prefilled']),
  cartridge: new Set(['cartridge', 'pod']),
  accessory: new Set(['accessory', 'coil', 'battery']),
  coil: new Set(['coil', 'accessory']),
  battery: new Set(['battery', 'accessory']),
  pouch: new Set(['pouch']),
};

const TYPE_HAYSTACK_RE = {
  e_liquid: /\b(e-?liquids?|e-?juices?|salt\s*nic|nic\s*salt|freebase|refill)\b/i,
  disposable:
    /\b(disposables?|disposable\s*vapes?|puff\s*bar|vape\s*bar|\d{1,3}\s*k\s*puffs?|\d{1,3}(?:,\d{3})+\s*puffs?|up\s*to\s*\d[\d,]*\s*puffs?)\b/i,
  device:
    /\b(devices?|vape\s*kits?|starter\s*kits?|pod\s*kits?|box\s*mods?|mods?\b|kits?\b|aio|all[- ]in[- ]one)\b/i,
  pod: /\b(pods?|pod\s*system|pod\s*kit)\b/i,
  prefilled: /\b(pre-?filled|prefilled\s*pods?)\b/i,
  cartridge: /\bcartridges?\b/i,
  accessory: /\b(accessories|accessor|charger|case)\b/i,
  coil: /\bcoils?\b/i,
  battery: /\bbatter(y|ies)\b/i,
  pouch: /\bpouches?\b/i,
};

/** Strong disposable signals — used to block e-liquid recommendations from mis-typed SKUs */
function looksLikeDisposable(product) {
  const hay = productHaystack(product);
  if (TYPE_HAYSTACK_RE.disposable.test(hay)) return true;
  if (/\b(rechargeable\s*battery|smart\s*display|draw[- ]?activate)\b/i.test(hay) && /\bpuffs?\b/i.test(hay)) {
    return true;
  }
  // High puff counts in the title are almost always disposables (e.g. MixPro 40K)
  if (/\b\d{2,3}\s*k\b/i.test(`${product.name || ''} ${product.variantName || ''}`) && /\bpuff/i.test(hay)) {
    return true;
  }
  return false;
}

/** Empty carts, 510s, coils, tanks — never recommend these as bottled e-liquid */
function looksLikeHardwareOrEmptyCart(product) {
  const hay = productHaystack(product);
  if (
    /\b(510|empty\s*cart|empty\s*cartridge|cartridges?|atomizers?|tanks?|coils?|drip\s*tips?|glass(?:ware)?|chargers?|batter(?:y|ies)|replacement\s*parts?|accessories)\b/i.test(
      hay
    )
  ) {
    // Allow real bottled juice that merely mentions "tank" in marketing copy only if clearly e-liquid
    if (TYPE_HAYSTACK_RE.e_liquid.test(hay) && !/\b(510|empty\s*cart|empty\s*cartridge|cartridges?)\b/i.test(hay)) {
      return false;
    }
    return true;
  }
  return false;
}

const FLAVOR_SIGNAL_RE =
  /\b(mango|berry|berries|strawberry|blueberry|raspberry|watermelon|grape|peach|lemon|lime|orange|citrus|mint|menthol|vanilla|tobacco|candy|gummy|dessert|fruity|fruit|ice|iced|tropical|melon|apple|banana|pineapple|coconut|cherry|cola|coffee)\b/i;

/** Empty mesh / replacement pods — never treat as flavored prefilled pods */
function looksLikeEmptyPodHardware(product) {
  const hay = productHaystack(product);
  if (/\b\d+(?:\.\d+)?\s*ohm\b/i.test(hay)) return true;
  if (/\b(mesh\s*pod|empty\s*pod|replacement\s*pod|refillable\s*pod|pod\s*coil)\b/i.test(hay)) {
    return true;
  }
  // Pod hardware with no flavor / prefilled language
  if (
    /\bpods?\b/i.test(hay) &&
    !TYPE_HAYSTACK_RE.prefilled.test(hay) &&
    !FLAVOR_SIGNAL_RE.test(hay) &&
    !looksLikeDisposable(product) &&
    /\b(device|kit|mod|ohm|mesh|coil|cartridge|atomizer|system)\b/i.test(hay)
  ) {
    return true;
  }
  return false;
}

/**
 * Bottled e-liquid signals only — small ml sizes alone (0.5ml / 1ml carts) are NOT e-liquid.
 */
function looksLikeELiquid(product) {
  const hay = productHaystack(product);
  if (looksLikeHardwareOrEmptyCart(product) || looksLikeDisposable(product)) return false;
  if (TYPE_HAYSTACK_RE.e_liquid.test(hay)) return true;

  const volumeMatch = hay.match(/\b(\d+(?:\.\d+)?)\s*m[lL]\b/);
  if (volumeMatch) {
    const ml = Number(volumeMatch[1]);
    // Typical bottled juice is > 2ml; ≤2ml is usually a pod/cart fill
    if (Number.isFinite(ml) && ml > 2) return true;
  }
  return false;
}

/**
 * Strict product-type match. Structured productType is respected, but clear
 * conflicting signals in the title/description always win (e.g. a "disposable"
 * or empty 510 cart miscategorized as e_liquid must not match an e-liquid request).
 */
export function matchesProductType(product, productType) {
  if (!productType) return true;

  const wanted = String(productType).toLowerCase();
  const actual = String(product.productType || '').toLowerCase();
  const compatible = TYPE_COMPAT[wanted] || new Set([wanted]);
  const disposableSignal = looksLikeDisposable(product);
  const hardwareSignal = looksLikeHardwareOrEmptyCart(product);
  const eLiquidSignal = looksLikeELiquid(product);
  const hay = productHaystack(product);

  // Haystack overrides mis-tagged Shopify types for the e-liquid boundary
  if (wanted === 'e_liquid') {
    if (disposableSignal || hardwareSignal || actual === 'disposable') return false;
    if (['cartridge', 'coil', 'battery', 'accessory', 'device', 'pod', 'prefilled'].includes(actual)) {
      return false;
    }
    // Never trust stored e_liquid alone when the title is clearly hardware
    if (actual === 'e_liquid') {
      return !hardwareSignal && !disposableSignal && (eLiquidSignal || TYPE_HAYSTACK_RE.e_liquid.test(hay));
    }
    if (actual === 'other' || !actual) {
      return eLiquidSignal;
    }
    return compatible.has(actual);
  }

  if (wanted === 'disposable') {
    if (disposableSignal) return true;
    if (actual === 'disposable') return true;
    if (hardwareSignal || (eLiquidSignal && !disposableSignal)) return false;
    if (actual && actual !== 'other') return compatible.has(actual);
    return TYPE_HAYSTACK_RE.disposable.test(hay);
  }

  // Flavored closed pods — never empty mesh / ohm replacement pods (even if mistyped)
  if (wanted === 'prefilled') {
    if (disposableSignal || eLiquidSignal || looksLikeEmptyPodHardware(product)) return false;
    if (actual === 'prefilled') return true;
    if (TYPE_HAYSTACK_RE.prefilled.test(hay)) return true;
    if (FLAVOR_SIGNAL_RE.test(hay) && /\bpods?\b/i.test(hay)) return true;
    return false;
  }

  // Pod systems / empty pods (hardware) — not flavored disposables or juice
  if (wanted === 'pod') {
    if (disposableSignal || eLiquidSignal) return false;
    if (looksLikeEmptyPodHardware(product)) return true;
    if (actual === 'pod') return true;
    if (actual && actual !== 'other' && actual !== 'prefilled') return compatible.has(actual);
    if (TYPE_HAYSTACK_RE.pod.test(hay) && !FLAVOR_SIGNAL_RE.test(hay)) return true;
    return false;
  }

  // Typed inventory row — enforce category strictly
  if (actual && actual !== 'other') {
    return compatible.has(actual);
  }

  // Untyped / other — infer from title/category
  if (wanted === 'device') {
    if (disposableSignal) return false;
    if (eLiquidSignal && !TYPE_HAYSTACK_RE.device.test(hay)) return false;
    // Empty carts / coils are not kits unless the title clearly says kit/device/mod
    if (
      /\b(510|empty\s*cart|empty\s*cartridge|cartridges?|coils?|drip\s*tips?)\b/i.test(hay) &&
      !TYPE_HAYSTACK_RE.device.test(hay)
    ) {
      return false;
    }
    return TYPE_HAYSTACK_RE.device.test(hay);
  }

  if (wanted !== 'e_liquid' && TYPE_HAYSTACK_RE.e_liquid.test(hay) && !TYPE_HAYSTACK_RE.pod.test(hay) && !disposableSignal) {
    return false;
  }
  if (wanted !== 'disposable' && disposableSignal) {
    return false;
  }

  const re = TYPE_HAYSTACK_RE[wanted];
  return re ? re.test(hay) : compatible.has(actual);
}

const FLAVOR_DIRECTION_RE = {
  fruity: /\b(fruit|fruity|berry|berries|mango|strawberry|peach|grape|melon|apple|tropical|citrus|lemon|lime|watermelon|cherry|banana|pineapple)\b/i,
  citrus: /\b(citrus|lemon|lime|orange|grapefruit)\b/i,
  tropical: /\b(tropical|mango|pineapple|passion|guava|coconut|papaya|kiwi|banana)\b/i,
  berry: /\b(berry|berries|strawberry|blueberry|raspberry|blackberry)\b/i,
  melon: /\b(melon|watermelon|honeydew|cantaloupe|grape)\b/i,
  menthol: /\b(menthol|mint|minty|spearmint|peppermint|cool)\b/i,
  dessert: /\b(dessert|custard|cream|vanilla|cake|bakery|pastry|cookie)\b/i,
  candy: /\b(candy|gummy|sweet|sour candy)\b/i,
  beverage: /\b(beverage|cola|soda|coffee|tea|energy|drink)\b/i,
};

/**
 * True when a product belongs to the requested brand (hard filter).
 * Matches inventory `brand` first; also allows clear brand tokens in the title.
 */
export function matchesBrand(product, brand) {
  if (!brand || brand === 'any') return true;
  const needle = foldText(brand);
  if (!needle || needle.length < 2) return true;

  const productBrand = foldText(product?.brand || '');
  if (productBrand) {
    if (
      productBrand === needle ||
      productBrand.includes(needle) ||
      needle.includes(productBrand)
    ) {
      return true;
    }
  }

  // Title often starts with the brand even when brand field is messy
  const name = foldText(product?.name || '');
  if (name) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(name)) return true;
  }

  return false;
}

/**
 * Filter inventory to products matching collected preferences.
 * Product type + selected brand are hard locks — never soft-fail into another category/brand.
 * @param {object[]} inventory
 * @param {object} prefs
 * @param {{ collapsePriority?: boolean }} [options]
 */
export function filterInventoryByPreferences(inventory = [], prefs = {}, options = {}) {
  const collapsePriority = options.collapsePriority !== false;
  let pool = Array.isArray(inventory) ? [...inventory] : [];
  if (!pool.length) return [];

  if (prefs.productType) {
    pool = pool.filter((p) => matchesProductType(p, prefs.productType));
    // Hard lock: empty means "nothing in this category", not "use full catalog"
    if (!pool.length) return [];
  }

  // Never recommend empty mesh pods when the shopper asked for a flavor
  if (
    (prefs.flavorDirection || (prefs.specificFlavors && prefs.specificFlavors.length)) &&
    (prefs.productType === 'prefilled' || prefs.productType === 'pod')
  ) {
    const flavored = pool.filter(
      (p) => !looksLikeEmptyPodHardware(p) && FLAVOR_SIGNAL_RE.test(productHaystack(p))
    );
    if (flavored.length) pool = flavored;
    else if (prefs.productType === 'prefilled') return [];
  }

  // Brand hard lock — apply BEFORE flavor/cooling so we never substitute another brand
  if (prefs.brand && prefs.brand !== 'any') {
    pool = pool.filter((p) => matchesBrand(p, prefs.brand));
    if (!pool.length) return [];
  }

  if (prefs.specificFlavors?.length) {
    const flavored = pool.filter((p) => {
      const hay = productHaystack(p);
      return prefs.specificFlavors.some((f) => hay.includes(String(f).toLowerCase()));
    });
    if (flavored.length) pool = flavored;
  } else if (prefs.flavorDirection && FLAVOR_DIRECTION_RE[prefs.flavorDirection]) {
    const re = FLAVOR_DIRECTION_RE[prefs.flavorDirection];
    const directed = pool.filter((p) => re.test(productHaystack(p)));
    if (directed.length) pool = directed;
  }

  if (prefs.cooling === 'no_ice') {
    const noIce = pool.filter((p) => !/\b(ice|iced|frost|freeze|menthol)\b/i.test(productHaystack(p)));
    if (noIce.length) pool = noIce;
  } else if (prefs.cooling === 'heavy_ice') {
    const heavy = pool.filter((p) =>
      /\b(heavy ice|max ice|ultra ice|icy|frostbite|freeze|extra ice)\b/i.test(productHaystack(p))
    );
    if (heavy.length) pool = heavy;
    else {
      const icy = pool.filter((p) => /\b(ice|iced|frost|menthol|cool)\b/i.test(productHaystack(p)));
      if (icy.length) pool = icy;
    }
  } else if (prefs.cooling === 'ice') {
    const icy = pool.filter((p) => /\b(ice|iced|frost|menthol|cool|chill)\b/i.test(productHaystack(p)));
    if (icy.length) pool = icy;
  }

  if (prefs.sweetness === 'sweet') {
    const sweet = pool.filter((p) =>
      /\b(sweet|sweeter|candy|gummy|dessert|sugar|honey|mango|strawberry|watermelon|peach|grape)\b/i.test(
        productHaystack(p)
      )
    );
    if (sweet.length) pool = sweet;
  } else if (prefs.sweetness === 'less_sweet') {
    const lessSweet = pool.filter(
      (p) => !/\b(candy|gummy|dessert|sugar|honey|very sweet)\b/i.test(productHaystack(p))
    );
    if (lessSweet.length) pool = lessSweet;
  }

  // Prefer priority promotions only inside the already brand+type locked pool
  if (collapsePriority) {
    const priority = pool.filter((p) => p.isPriorityPromotion);
    if (priority.length) return priority;
  }

  return pool;
}

export function preferencesToHint(prefs = {}) {
  const bits = [];
  if (prefs.productType) bits.push(TYPE_LABELS[prefs.productType] || prefs.productType);
  if (prefs.flavorDirection) bits.push(prefs.flavorDirection);
  if (prefs.specificFlavors?.length) bits.push(prefs.specificFlavors.join(', '));
  if (prefs.cooling === 'ice') bits.push('ice');
  if (prefs.cooling === 'heavy_ice') bits.push('heavy ice');
  if (prefs.cooling === 'no_ice') bits.push('no ice');
  if (prefs.cooling === 'any') bits.push('any ice level');
  if (prefs.sweetness) bits.push(prefs.sweetness);
  if (prefs.brand && prefs.brand !== 'any') bits.push(prefs.brand);
  if (prefs.brand === 'any') bits.push('any brand');
  if (prefs.rawHints?.length) bits.push(prefs.rawHints[prefs.rawHints.length - 1]);
  return bits.filter(Boolean).join(' | ');
}

export function emptyPreferences() {
  return {
    productType: null,
    flavorDirection: null,
    specificFlavors: [],
    cooling: null,
    sweetness: null,
    brand: null,
    rawHints: [],
  };
}

/** Human summary of what we already know, e.g. "a fruity disposable (mango)" */
export function summarizeCollectedPreferences(prefs = {}) {
  const p = prefs || {};
  const parts = [];
  if (p.flavorDirection) parts.push(p.flavorDirection);
  if (p.specificFlavors?.length) {
    parts.push(p.specificFlavors.join('/'));
  }
  const typeLabel = p.productType ? TYPE_LABELS[p.productType] || p.productType : null;
  const typeSingular = typeLabel
    ? typeLabel.toLowerCase().replace(/s$/, '').replace(/e-liquid$/, 'e-liquid')
    : null;
  const articleFor = (word) => (/^[aeiou]/i.test(String(word || '')) ? 'an' : 'a');

  if (!parts.length && typeSingular) {
    return `${articleFor(typeSingular)} ${typeSingular} option`;
  }
  if (parts.length && typeSingular) {
    const phrase = `${parts.join(' ')} ${typeSingular}`;
    return `${articleFor(parts[0])} ${phrase}`;
  }
  if (parts.length) return parts.join(' ');
  return null;
}

/**
 * Interpret short/ambiguous answers in the context of the question we just asked.
 */
export function applyContextualAnswer(message, lastAsked, preferences = {}) {
  const raw = sanitizeUserHint(message);
  const t = foldText(raw);
  const next = { ...preferences };
  if (!lastAsked || !t) {
    return { preferences: next, unclear: null, resolved: false };
  }

  if (lastAsked === 'cooling') {
    // "both" is ambiguous — cannot set ice and no-ice together
    if (/\bboth\b/.test(t) && !/\beither is fine\b/.test(t)) {
      return { preferences: next, unclear: 'both', resolved: false };
    }
    if (
      /\b(any|doesn't matter|doesnt matter|no preference|whatever|surprise me|you (pick|choose)|either is fine|either way|best (one|option|match)|pick (for me|the best))\b/.test(
        t
      )
    ) {
      next.cooling = 'any';
      return { preferences: next, unclear: null, resolved: true };
    }
    if (/\b(heavy ice|extra ice|max ice|strong ice)\b/.test(t)) {
      next.cooling = 'heavy_ice';
      return { preferences: next, unclear: null, resolved: true };
    }
    if (
      /\b(with ice|ice please|iced|icy|cooling|cool finish)\b/.test(t) ||
      /^(ice|yes|yeah|yep|sure)$/.test(t)
    ) {
      next.cooling = 'ice';
      return { preferences: next, unclear: null, resolved: true };
    }
    if (
      /\b(no ice|without ice|no cooling|smooth without|non-?ice|not iced)\b/.test(t) ||
      /^(no|nope|without|smooth)$/.test(t)
    ) {
      next.cooling = 'no_ice';
      return { preferences: next, unclear: null, resolved: true };
    }
    // Short unclear reply while waiting on ice
    if (t.split(/\s+/).length <= 3 && !/\b(ice|cool|smooth|menthol)\b/.test(t)) {
      return { preferences: next, unclear: 'unclear', resolved: false };
    }
  }

  if (lastAsked === 'flavor') {
    if (/\b(any|doesn't matter|surprise|you choose)\b/.test(t)) {
      next.flavorDirection = next.flavorDirection || 'fruity';
      return { preferences: next, unclear: null, resolved: true };
    }
  }

  if (lastAsked === 'productType') {
    if (/\b(any|doesn't matter|surprise)\b/.test(t)) {
      return { preferences: next, unclear: 'productType_any', resolved: false };
    }
  }

  if (lastAsked === 'brand') {
    if (BRAND_NO_PREF_RE.test(t) || /^(no|none|nah|idk|n\/a)$/i.test(raw.trim())) {
      next.brand = 'any';
      return { preferences: next, unclear: null, resolved: true };
    }
    if (raw.trim()) {
      next.brand = raw.trim();
      return { preferences: next, unclear: null, resolved: true };
    }
  }

  return { preferences: next, unclear: null, resolved: false };
}

/**
 * Context-aware follow-up — references collected prefs and avoids repeating the same line.
 */
export function buildContextualFollowUp(prefs, missing, meta = {}) {
  const summary = summarizeCollectedPreferences(prefs);
  const attempt = Number(meta.askAttempts?.[missing] || 0);
  const unclear = meta.unclear;

  if (missing === 'cooling') {
    const flavorHint =
      prefs?.specificFlavors?.length > 0
        ? prefs.specificFlavors.slice(0, 2).join('/')
        : prefs?.flavorDirection || null;
    const eitherWay = flavorHint
      ? `or should I pick the best ${flavorHint} option available either way?`
      : 'or should I pick the best match available either way?';

    if (unclear === 'both') {
      return [
        summary
          ? `I understand you're looking for ${summary}.`
          : 'I can help you lock in the finish.',
        '',
        "Ice and no-ice are different experiences, so I can't apply both to a single recommendation.",
        '',
        `Did you want an icy / cooling effect, a smooth finish without ice, ${eitherWay}`,
      ].join('\n');
    }
    if (unclear === 'unclear' || attempt >= 1) {
      return [
        summary ? `We're already set on ${summary}.` : 'Almost there.',
        '',
        'I just need your ice preference to finish:',
        '',
        '• Strong / icy cooling',
        '• Smooth with no ice',
        '• No preference — pick the best match either way',
      ].join('\n');
    }
    return [
      summary ? `Nice — ${summary}.` : 'Got it.',
      '',
      'Would you like it with ice / cooling, or smooth without ice?',
    ].join('\n');
  }

  if (missing === 'flavor') {
    if (attempt >= 1) {
      return [
        summary ? `Looking for ${summary}.` : 'Happy to help.',
        '',
        'What taste are you after — fruity, menthol, dessert, or a specific fruit like mango or strawberry?',
      ].join('\n');
    }
    return [
      summary ? `Got it — ${summary}.` : 'Got it.',
      '',
      'What flavor direction do you prefer — fruity, menthol/mint, dessert, candy, or citrus? You can also name a fruit like mango or strawberry.',
    ].join('\n');
  }

  if (missing === 'productType') {
    if (attempt >= 1) {
      return [
        summary ? `Noted: ${summary}.` : 'Happy to help.',
        '',
        'Which product type should I search — disposable vapes, e-liquids, pods, devices, or accessories?',
      ].join('\n');
    }
    return [
      summary ? `Nice — ${summary}.` : 'Got it.',
      '',
      meta.defaultAsk ||
        'What type of product do you want — e-liquids, disposables, pods, or accessories?',
    ].join('\n');
  }

  if (missing === 'brand') {
    if (attempt >= 1) {
      return [
        summary ? `We've got ${summary}.` : 'Almost ready.',
        '',
        meta.defaultAsk ||
          'Any preferred brand, or should I pick the best match with no brand preference?',
      ].join('\n');
    }
    return [
      summary ? `Perfect — ${summary}.` : 'Got it.',
      '',
      meta.defaultAsk ||
        'Do you have a preferred brand? If not, just say "No Preference."',
    ].join('\n');
  }

  return meta.defaultAsk || 'Tell me a bit more about what you want.';
}

/** @deprecated use buildContextualFollowUp */
export function buildFollowUpAck(prefs, ask) {
  return buildContextualFollowUp(prefs, 'cooling', { defaultAsk: ask, askAttempts: {} });
}

export function foldPrefText(value) {
  return foldText(value);
}
