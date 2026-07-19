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
} from '../utils/nlu.js';

const LIQUID_LIKE = new Set(['e_liquid', 'disposable', 'prefilled', 'pod', 'pouch']);

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
 */
export function summarizeInventoryOfferings(inventory = []) {
  const found = new Set();
  for (const p of inventory) {
    const type = String(p.productType || '').toLowerCase();
    if (type && TYPE_LABELS[type]) found.add(type);
    const hay = `${p.category || ''} ${p.name || ''}`.toLowerCase();
    if (/\be-?liquid|e-?juice|salt\s*nic/i.test(hay)) found.add('e_liquid');
    if (/\bdisposables?\b/i.test(hay)) found.add('disposable');
    if (/\baccessor/i.test(hay)) found.add('accessory');
    if (/\bpod\b/i.test(hay)) found.add('pod');
    if (/\bdevice|kit|mod\b/i.test(hay)) found.add('device');
  }
  return [...found];
}

export function buildOpenShoppingPrompt(inventory = [], storeName = null) {
  const types = summarizeInventoryOfferings(inventory);
  const labels = types.map((t) => TYPE_LABELS[t]).filter(Boolean);
  const uniqueLabels = [...new Set(labels)];

  const offeringLine = uniqueLabels.length
    ? `We have different options available, including ${formatList(uniqueLabels)}, plus flavors across those categories.`
    : 'We have a range of products and flavors available in this store.';

  const storeBit = storeName ? ` at ${storeName}` : '';

  return [
    `What are you looking for today${storeBit}?`,
    '',
    offeringLine,
    '',
    'You can tell me your preference in your own words — for example: fruity e-liquids, menthol, dessert flavors, disposable vapes, pods, accessories, something icy, or a mango/strawberry vibe.',
  ].join('\n');
}

function formatList(items) {
  if (items.length <= 1) return items[0] || 'products';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
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
    rawHints: clean ? [clean] : [],
  };

  // Product type
  if (hasConcept('eliquid') || /\be[\s-]?liquids?\b|\be[\s-]?juices?\b|\bsalt\s*nic/i.test(clean)) {
    prefs.productType = 'e_liquid';
  } else if (hasConcept('disposable') || /\bdisposables?\b|\bdispo\b/i.test(clean)) {
    prefs.productType = 'disposable';
  } else if (hasConcept('pod') || /\bpod\s*(system|kit|kits)?s?\b/i.test(clean)) {
    prefs.productType = 'pod';
  } else if (hasConcept('device') || /\b(device|kit|mod|starter)\b/i.test(clean)) {
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
    // Menthol/mint almost always implies a cooling finish
    if (prefs.cooling == null) prefs.cooling = 'ice';
  } else if (hasToken('dessert') || hasToken('custard') || hasToken('vanilla') || hasToken('cream')) {
    prefs.flavorDirection = 'dessert';
  } else if (hasToken('candy') || hasToken('gummy')) {
    prefs.flavorDirection = 'candy';
  } else if (hasToken('fruity') || hasToken('fruit') || hasToken('fruits') || hasConcept('fruity')) {
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

  // Cooling
  if (/\b(no ice|without ice|no cooling|not iced|smooth without)\b/i.test(clean)) {
    prefs.cooling = 'no_ice';
  } else if (/\b(heavy ice|extra ice|max ice|ultra ice)\b/i.test(clean)) {
    prefs.cooling = 'heavy_ice';
  } else if (
    hasToken('ice') ||
    hasToken('icy') ||
    hasToken('iced') ||
    hasToken('cooling') ||
    /\b(cool finish|cold finish|frost|chill)\b/i.test(clean)
  ) {
    prefs.cooling = 'ice';
  }

  // Sweetness
  if (hasToken('sweet') || /\bsweeter\b/i.test(clean)) prefs.sweetness = 'sweet';
  if (/\b(less sweet|not sweet|not too sweet)\b/i.test(clean)) prefs.sweetness = 'less_sweet';

  return prefs;
}

export function mergePreferences(previous = {}, incoming = {}) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const next = { ...prev };

  if (incoming.productType) next.productType = incoming.productType;
  if (incoming.flavorDirection) next.flavorDirection = incoming.flavorDirection;
  if (incoming.cooling) next.cooling = incoming.cooling;
  if (incoming.sweetness) next.sweetness = incoming.sweetness;

  const flavors = [
    ...(Array.isArray(prev.specificFlavors) ? prev.specificFlavors : []),
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

  return { ready: true, missing: null, ask: null };
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

function matchesProductType(product, productType) {
  if (!productType) return true;
  if (String(product.productType || '').toLowerCase() === productType) return true;
  const hay = productHaystack(product);
  const map = {
    e_liquid: /\be-?liquid|e-?juice|salt\s*nic|nic\s*salt/i,
    disposable: /\bdisposables?\b/i,
    device: /\b(device|kit|mod)\b/i,
    pod: /\bpod\b/i,
    accessory: /\baccessor|coil|charger|case\b/i,
    pouch: /\bpouch/i,
    prefilled: /\bprefilled|pre-filled\b/i,
  };
  return map[productType] ? map[productType].test(hay) : true;
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
 * Filter inventory to products matching collected preferences.
 */
export function filterInventoryByPreferences(inventory = [], prefs = {}) {
  let pool = Array.isArray(inventory) ? [...inventory] : [];
  if (!pool.length) return [];

  if (prefs.productType) {
    const typed = pool.filter((p) => matchesProductType(p, prefs.productType));
    if (typed.length) pool = typed;
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
      /\b(heavy ice|max ice|ultra ice|icy|frostbite|freeze)\b/i.test(productHaystack(p))
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
    const sweet = pool.filter((p) => /\b(sweet|candy|dessert|sugar|mango|strawberry)\b/i.test(productHaystack(p)));
    if (sweet.length) pool = sweet;
  }

  // Prefer priority promotions when present
  const priority = pool.filter((p) => p.isPriorityPromotion);
  if (priority.length) return priority;

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
  if (prefs.sweetness) bits.push(prefs.sweetness);
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
    rawHints: [],
  };
}

/** Follow-up after acknowledging a partial preference in the open prompt turn */
export function buildFollowUpAck(prefs, ask) {
  const bits = [];
  if (prefs.productType) bits.push(TYPE_LABELS[prefs.productType] || prefs.productType);
  if (prefs.flavorDirection) bits.push(prefs.flavorDirection);
  if (prefs.specificFlavors?.length) bits.push(prefs.specificFlavors.join('/'));
  if (prefs.cooling === 'ice' || prefs.cooling === 'heavy_ice') bits.push('icy');
  if (prefs.cooling === 'no_ice') bits.push('no ice');

  if (!bits.length) return ask;
  return `Nice — ${bits.join(', ')}. ${ask}`;
}

export function foldPrefText(value) {
  return foldText(value);
}
