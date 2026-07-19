import Store from '../models/Store.js';
import StoreInventory from '../models/StoreInventory.js';
import { env } from '../config/env.js';
import { getEntryStep, getTaxonomyStep, isBrandStep } from './taxonomy.service.js';

/**
 * Dynamic GPT funnel helpers — step count and options come from store taxonomy.
 * After a parent product is chosen, optional variant_refine narrows sibling flavors.
 */

const MAX_DIRECT_VARIANT_OPTIONS = 6;

const FRUIT_PROFILES = [
  {
    id: 'berry',
    label: 'Berry',
    emoji: '🍓',
    keywords: /\b(berry|berries|blueberry|strawberry|raspberry|blackberry|cranberry|mixed berry)\b/i,
  },
  {
    id: 'tropical',
    label: 'Tropical',
    emoji: '🍍',
    keywords: /\b(mango|pineapple|passion|guava|coconut|papaya|kiwi|banana|tropical)\b/i,
  },
  {
    id: 'citrus',
    label: 'Citrus',
    emoji: '🍊',
    keywords: /\b(citrus|lemon|lime|orange|grapefruit|tangerine|lemon\-lime)\b/i,
  },
  {
    id: 'melon_grape',
    label: 'Melon / Grape',
    emoji: '🍉',
    keywords: /\b(grape|watermelon|melon|honeydew|cantaloupe)\b/i,
  },
  {
    id: 'stone_fruit',
    label: 'Stone Fruit',
    emoji: '🍑',
    keywords: /\b(peach|apricot|plum|cherry|nectarine)\b/i,
  },
];

const TASTE_PROFILES = [
  {
    id: 'sweet',
    label: 'Sweet',
    emoji: '🍬',
    keywords: /\b(sweet|candy|dessert|cream|vanilla|cake|custard|sugar)\b/i,
  },
  {
    id: 'tart',
    label: 'Tart / Sour',
    emoji: '🍋',
    keywords: /\b(sour|tart|tangy|acid|zesty)\b/i,
  },
  {
    id: 'icy',
    label: 'Icy / Menthol',
    emoji: '🧊',
    keywords: /\b(ice|iced|frost|menthol|cool|freeze|chill)\b/i,
  },
  {
    id: 'smooth',
    label: 'Smooth',
    emoji: '✨',
    keywords: /\b(smooth|mellow|mild|soft|creamy)\b/i,
  },
];

export function serializeProductCard(product) {
  if (!product) return null;
  const productUrl =
    (typeof product.productUrl === 'string' && product.productUrl.trim()) ||
    (typeof product.originalProductUrl === 'string' && product.originalProductUrl.trim()) ||
    null;
  return {
    id: String(product._id),
    name: product.name,
    brand: product.brand,
    flavor: product.flavor,
    description: product.description,
    imageUrl: product.imageUrl,
    category: product.category,
    subcategory: product.subcategory,
    variantName: product.variantName,
    nicotineStrength: product.nicotineStrength,
    nicotineMgMl: product.nicotineMgMl,
    bottleSize: product.bottleSize,
    volumeMl: product.volumeMl,
    price: product.price,
    /** Canonical storefront PDP URL */
    productUrl,
    /** Spec alias — same value as productUrl */
    originalProductUrl: productUrl,
    isPriorityPromotion: Boolean(product.isPriorityPromotion),
  };
}

export function formatOptionsForClient(step) {
  if (!step?.options?.length) return [];
  return step.options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    emoji: opt.emoji || '',
    value: opt.label,
  }));
}

export function matchOption(step, userMessage) {
  if (!step?.options?.length) return null;
  const text = String(userMessage || '').trim().toLowerCase();
  if (!text) return null;

  // Explicit option token: ::option::<id>
  const token = text.match(/^::option::(.+)$/i);
  if (token) {
    const id = token[1].trim();
    return step.options.find((o) => String(o.id) === id) || null;
  }

  const exact = step.options.find((o) => {
    const label = String(o.label || '').toLowerCase();
    const withEmoji = `${o.emoji || ''} ${o.label || ''}`.trim().toLowerCase();
    return text === label || text === withEmoji || text.includes(label);
  });
  if (exact) return exact;

  return (
    step.options.find((o) => text.includes(String(o.label || '').toLowerCase())) || null
  );
}

export async function loadProductsByIds(ids = []) {
  if (!ids.length) return [];
  const products = await StoreInventory.find({
    _id: { $in: ids },
    isActive: true,
  }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Human-readable flavor label for a variant-level inventory row */
export function getVariantLabel(product) {
  const variant = String(product?.variantName || '').trim();
  if (variant) return variant;
  const flavor = String(product?.flavor || '').trim();
  if (flavor) return flavor;
  const name = String(product?.name || '').trim();
  const split = name.split(/\s[-–|/]\s/);
  if (split.length > 1) return split[split.length - 1].trim();
  return name || 'Variant';
}

export function getParentDisplayName(product) {
  if (!product) return 'this product';
  const variant = String(product.variantName || '').trim();
  const name = String(product.name || '').trim();
  if (variant && name) {
    const stripped = name
      .replace(new RegExp(`\\s*[-–|/:]\\s*${escapeRegExp(variant)}\\s*$`, 'i'), '')
      .trim();
    if (stripped && stripped.toLowerCase() !== name.toLowerCase()) return stripped;
  }
  if (product.brand) return product.brand;
  const parts = name.split(/\s[-–|/]\s/);
  return parts[0] || name || 'this product';
}

function variantHaystack(product) {
  return [
    product.variantName,
    product.flavor,
    product.name,
    product.description,
    product.subcategory,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Load sibling flavor variants for a chosen inventory row (same parentExternalId).
 * Distinct by flavor label; requires more than one unique flavor.
 */
export async function findSiblingVariants(chosen) {
  if (!chosen?.parentExternalId || !chosen.storeId) return [];

  const siblings = await StoreInventory.find({
    storeId: chosen.storeId,
    parentExternalId: chosen.parentExternalId,
    isActive: true,
  })
    .sort({ isPriorityPromotion: -1, name: 1 })
    .lean();

  const byLabel = new Map();
  for (const row of siblings) {
    const label = getVariantLabel(row).toLowerCase();
    if (!label) continue;
    if (!byLabel.has(label)) byLabel.set(label, row);
  }

  return Array.from(byLabel.values());
}

function buildDirectVariantOptions(candidates) {
  return candidates.map((p) => ({
    id: `var_${p._id}`,
    label: getVariantLabel(p),
    emoji: guessVariantEmoji(getVariantLabel(p)),
    productIds: [String(p._id)],
    isFinal: true,
  }));
}

function guessVariantEmoji(label) {
  const t = String(label || '').toLowerCase();
  if (/berry|strawberry|raspberry|blueberry/.test(t)) return '🍓';
  if (/mango|pineapple|tropical|guava|passion/.test(t)) return '🍍';
  if (/lemon|lime|orange|citrus|grapefruit/.test(t)) return '🍊';
  if (/grape|watermelon|melon/.test(t)) return '🍉';
  if (/peach|cherry|apricot/.test(t)) return '🍑';
  if (/mint|menthol|ice|frost|cool/.test(t)) return '🧊';
  if (/cream|dessert|vanilla|cake|candy/.test(t)) return '🍰';
  if (/tobacco|classic/.test(t)) return '🍂';
  return '✨';
}

function partitionByProfiles(candidates, profiles) {
  const groups = [];
  const assigned = new Set();

  for (const profile of profiles) {
    const ids = [];
    for (const p of candidates) {
      const id = String(p._id);
      if (assigned.has(id)) continue;
      if (profile.keywords.test(variantHaystack(p))) {
        ids.push(id);
        assigned.add(id);
      }
    }
    if (ids.length >= 1) {
      groups.push({
        id: profile.id,
        label: profile.label,
        emoji: profile.emoji || '',
        productIds: ids,
      });
    }
  }

  return groups;
}

function partitionByIce(candidates) {
  const ice = [];
  const noIce = [];
  for (const p of candidates) {
    const hay = variantHaystack(p);
    if (/\b(ice|iced|frost|menthol|cool|freeze|chill)\b/.test(hay)) ice.push(String(p._id));
    else noIce.push(String(p._id));
  }
  const groups = [];
  if (ice.length) {
    groups.push({
      id: 'ice',
      label: 'Ice / Cooling',
      emoji: '❄️',
      productIds: ice,
    });
  }
  if (noIce.length) {
    groups.push({
      id: 'no_ice',
      label: 'No Ice',
      emoji: '🌿',
      productIds: noIce,
    });
  }
  return groups;
}

function partitionByIceStrength(candidates) {
  const heavy = [];
  const light = [];
  const none = [];
  for (const p of candidates) {
    const hay = variantHaystack(p);
    const id = String(p._id);
    if (/\b(heavy ice|max ice|icy|frostbite|freeze|ultra ice)\b/.test(hay)) heavy.push(id);
    else if (/\b(ice|iced|frost|menthol|cool|chill)\b/.test(hay)) light.push(id);
    else none.push(id);
  }
  const groups = [];
  if (light.length) {
    groups.push({ id: 'light_ice', label: 'Light / Medium Ice', emoji: '❄️', productIds: light });
  }
  if (heavy.length) {
    groups.push({ id: 'heavy_ice', label: 'Heavy Ice', emoji: '🧊', productIds: heavy });
  }
  if (none.length) {
    groups.push({ id: 'no_ice_str', label: 'No Ice', emoji: '🌿', productIds: none });
  }
  return groups;
}

/**
 * Choose the next guided question (or direct variant list) for remaining siblings.
 */
export function buildNextVariantQuestion(candidates, variantPath = []) {
  const asked = new Set((variantPath || []).map((p) => p.dimension));

  if (!candidates.length) return null;

  if (candidates.length <= MAX_DIRECT_VARIANT_OPTIONS) {
    return {
      dimension: 'variant',
      prompt:
        candidates.length === 2
          ? 'Which of these two flavors sounds best?'
          : 'Which flavor variant would you like?',
      options: buildDirectVariantOptions(candidates),
    };
  }

  // Ice vs no-ice when both sides are meaningful
  if (!asked.has('ice')) {
    const iceGroups = partitionByIce(candidates);
    if (
      iceGroups.length >= 2 &&
      iceGroups.every((g) => g.productIds.length >= 1) &&
      iceGroups.some((g) => g.productIds.length >= 2)
    ) {
      return {
        dimension: 'ice',
        prompt:
          'Do you enjoy a refreshing icy finish, or would you prefer something smooth without cooling?',
        options: iceGroups.map((g) => ({
          id: g.id,
          label: g.label,
          emoji: g.emoji,
          productIds: g.productIds,
          isFinal: false,
        })),
      };
    }
  }

  // Fruit family when multiple distinct profiles match
  if (!asked.has('fruit')) {
    const fruitGroups = partitionByProfiles(candidates, FRUIT_PROFILES).filter(
      (g) => g.productIds.length >= 1
    );
    if (fruitGroups.length >= 2) {
      const covered = fruitGroups.reduce((n, g) => n + g.productIds.length, 0);
      if (covered >= Math.min(4, candidates.length * 0.5)) {
        return {
          dimension: 'fruit',
          prompt: 'Do you prefer berries, tropical fruits, citrus, or something sweeter like melon or grape?',
          options: fruitGroups.map((g) => ({
            id: g.id,
            label: g.label,
            emoji: g.emoji,
            productIds: g.productIds,
            isFinal: false,
          })),
        };
      }
    }
  }

  // Taste / mouthfeel
  if (!asked.has('taste')) {
    const tasteGroups = partitionByProfiles(candidates, TASTE_PROFILES).filter(
      (g) => g.productIds.length >= 1
    );
    if (tasteGroups.length >= 2) {
      return {
        dimension: 'taste',
        prompt: 'Are you more into sweet, dessert-like, candy, beverage, or a cleaner mint/menthol taste?',
        options: tasteGroups.map((g) => ({
          id: g.id,
          label: g.label,
          emoji: g.emoji,
          productIds: g.productIds,
          isFinal: false,
        })),
      };
    }
  }

  // Ice strength among icy variants
  if (!asked.has('ice_strength')) {
    const strength = partitionByIceStrength(candidates).filter((g) => g.productIds.length >= 1);
    if (strength.length >= 2 && strength.some((g) => g.id !== 'no_ice_str')) {
      return {
        dimension: 'ice_strength',
        prompt: 'Would you like light cooling, heavy ice, or no ice at all?',
        options: strength.map((g) => ({
          id: g.id,
          label: g.label,
          emoji: g.emoji,
          productIds: g.productIds,
          isFinal: false,
        })),
      };
    }
  }

  // Fallback: show a manageable direct list (top by priority/name)
  const limited = candidates.slice(0, MAX_DIRECT_VARIANT_OPTIONS);
  return {
    dimension: 'variant',
    prompt: 'Which of these flavor variants sounds closest to what you want?',
    options: buildDirectVariantOptions(limited),
  };
}

function buildVariantIntro(parentName, questionPrompt, isFirst) {
  if (!isFirst) return questionPrompt;
  return [
    'Great choice!',
    '',
    `Based on your preferences, I found a product that matches what you're looking for: ${parentName}.`,
    '',
    'This product is available in several flavor variants. Let\'s find the best one for you.',
    '',
    questionPrompt,
  ].join('\n');
}

async function startVariantRefine(store, session, chosen, path = []) {
  const siblings = await findSiblingVariants(chosen);
  if (siblings.length <= 1) return null;

  const parentName = getParentDisplayName(chosen);
  const question = buildNextVariantQuestion(siblings, []);
  if (!question) return null;

  session.funnelState = {
    phase: 'variant_refine',
    currentStepId: null,
    candidateProductIds: siblings.map((p) => String(p._id)),
    parentExternalId: chosen.parentExternalId,
    variantPath: [],
    path,
  };

  return {
    reply: buildVariantIntro(parentName, question.prompt, true),
    replyType: 'options',
    options: formatOptionsForClient({ options: question.options }),
    products: [],
    funnel: session.funnelState,
    variantQuestion: question,
  };
}

async function completeVariantRecommendation(store, session, product, path = []) {
  const card = serializeProductCard(product);
  const reply = product
    ? buildRecommendationText(product)
    : "I couldn't find a perfect match in stock right now. Tell me another preference and I'll try again.";

  session.funnelState = {
    phase: 'recommendation',
    currentStepId: null,
    candidateProductIds: product ? [String(product._id)] : [],
    parentExternalId: product?.parentExternalId || session.funnelState?.parentExternalId || null,
    variantPath: session.funnelState?.variantPath || [],
    path,
  };

  return {
    reply,
    replyType: product ? 'recommendation' : 'text',
    options: [
      {
        id: 'another',
        label: 'Get Another Recommendation',
        emoji: '✨',
        value: 'Get Another Recommendation',
      },
    ],
    products: card ? [card] : [],
    funnel: session.funnelState,
  };
}

/**
 * Advance the variant refinement phase.
 */
export async function advanceVariantRefine(store, session, userMessage) {
  const state = session.funnelState || {};
  const candidateIds = (state.candidateProductIds || []).map(String);
  let candidates = await loadProductsByIds(candidateIds);

  if (!candidates.length && state.parentExternalId) {
    candidates = await StoreInventory.find({
      storeId: store._id,
      parentExternalId: state.parentExternalId,
      isActive: true,
    }).lean();
  }

  if (!candidates.length) {
    return completeVariantRecommendation(store, session, null, state.path || []);
  }

  if (candidates.length === 1) {
    return completeVariantRecommendation(store, session, candidates[0], state.path || []);
  }

  const currentQuestion = buildNextVariantQuestion(candidates, state.variantPath || []);
  const option = currentQuestion ? matchOption({ options: currentQuestion.options }, userMessage) : null;

  if (!option) {
    // Free-text: pick best among remaining variants
    const chosen = await pickBestProduct(store, candidates, state.path || [], userMessage);
    return completeVariantRecommendation(store, session, chosen, state.path || []);
  }

  const narrowedIds = (option.productIds || []).map(String);
  const narrowed = candidates.filter((p) => narrowedIds.includes(String(p._id)));
  const nextCandidates = narrowed.length ? narrowed : candidates;

  const nextPath = [
    ...(state.variantPath || []),
    {
      dimension: currentQuestion.dimension,
      optionId: option.id,
      label: option.label,
    },
  ];

  // Single remaining or explicit final variant pick
  if (option.isFinal || nextCandidates.length === 1) {
    const chosen =
      nextCandidates.length === 1
        ? nextCandidates[0]
        : nextCandidates.find((p) => String(p._id) === narrowedIds[0]) || nextCandidates[0];
    return completeVariantRecommendation(store, session, chosen, state.path || []);
  }

  if (nextCandidates.length <= 2) {
    // Present the last 2 as buttons
    const question = buildNextVariantQuestion(nextCandidates, nextPath);
    session.funnelState = {
      ...state,
      phase: 'variant_refine',
      candidateProductIds: nextCandidates.map((p) => String(p._id)),
      variantPath: nextPath,
    };
    return {
      reply: question.prompt,
      replyType: 'options',
      options: formatOptionsForClient({ options: question.options }),
      products: [],
      funnel: session.funnelState,
    };
  }

  const nextQuestion = buildNextVariantQuestion(nextCandidates, nextPath);
  session.funnelState = {
    ...state,
    phase: 'variant_refine',
    candidateProductIds: nextCandidates.map((p) => String(p._id)),
    variantPath: nextPath,
  };

  return {
    reply: nextQuestion.prompt,
    replyType: 'options',
    options: formatOptionsForClient({ options: nextQuestion.options }),
    products: [],
    funnel: session.funnelState,
  };
}

/**
 * Advance past brand-selection steps in-place (mutates session.funnelState).
 * Returns the presentable non-brand step, or null if recommendation should run instead.
 */
function advancePastBrandSteps(store, session, step, candidateIds, path) {
  const taxonomy = store.recommendationTaxonomy;
  let current = step;
  let pool = (candidateIds || []).map(String);
  const visited = new Set();

  while (current && isBrandStep(current) && !visited.has(current.id)) {
    visited.add(current.id);
    const allIds = [
      ...new Set(current.options.flatMap((o) => o.productIds || []).map(String)),
    ];
    if (pool.length) {
      const intersect = pool.filter((id) => allIds.includes(id));
      pool = intersect.length ? intersect : allIds;
    } else {
      pool = allIds;
    }

    const nextIds = [
      ...new Set(current.options.map((o) => o.nextStepId).filter(Boolean)),
    ];
    if (nextIds.length === 1) {
      current = getTaxonomyStep(taxonomy, nextIds[0]);
      continue;
    }
    session.funnelState = {
      ...(session.funnelState || {}),
      phase: 'funnel',
      currentStepId: null,
      candidateProductIds: pool,
      path: path || session.funnelState?.path || [],
      preferenceHints: session.funnelState?.preferenceHints || [],
    };
    return { step: null, candidateProductIds: pool, shouldRecommend: true };
  }

  if (!current) {
    session.funnelState = {
      ...(session.funnelState || {}),
      phase: 'funnel',
      candidateProductIds: pool,
      path: path || session.funnelState?.path || [],
      preferenceHints: session.funnelState?.preferenceHints || [],
    };
    return { step: null, candidateProductIds: pool, shouldRecommend: true };
  }

  session.funnelState = {
    ...(session.funnelState || {}),
    phase: 'funnel',
    currentStepId: current.id,
    candidateProductIds: pool.length
      ? pool
      : session.funnelState?.candidateProductIds || [],
    parentExternalId: session.funnelState?.parentExternalId ?? null,
    variantPath: session.funnelState?.variantPath || [],
    path: path || session.funnelState?.path || [],
    preferenceHints: session.funnelState?.preferenceHints || [],
  };

  return { step: current, candidateProductIds: pool, shouldRecommend: false };
}

/**
 * Skip brand-selection steps at runtime (covers taxonomies built before brand removal).
 */
async function resolvePastBrandSteps(store, session, step, candidateIds, path) {
  const resolved = advancePastBrandSteps(store, session, step, candidateIds, path);
  const hints = (session.funnelState?.preferenceHints || []).filter(Boolean).join(' | ');

  if (resolved.shouldRecommend) {
    return finalizeRecommendation(
      store,
      session,
      resolved.candidateProductIds,
      path || [],
      hints
    );
  }

  if (resolved.step && resolved.step !== step) {
    return {
      reply: resolved.step.prompt,
      replyType: 'options',
      options: formatOptionsForClient(resolved.step),
      products: [],
      funnel: session.funnelState,
      stepId: resolved.step.id,
    };
  }

  return null;
}

/**
 * Start funnel after age verification.
 */
export async function beginFunnel(store, session) {
  const taxonomy = store.recommendationTaxonomy;
  const entry = getEntryStep(taxonomy);

  if (taxonomy?.autoRecommendProductIds?.length && !entry) {
    return finalizeRecommendation(store, session, taxonomy.autoRecommendProductIds, []);
  }

  if (!entry) {
    // No taxonomy — free chat fallback message
    session.funnelState = {
      phase: 'free_chat',
      currentStepId: null,
      candidateProductIds: [],
      parentExternalId: null,
      variantPath: [],
      path: [],
      preferenceHints: [],
    };
    const reply =
      "Thanks for confirming. Tell me what you're looking for — flavors, product types, cooling level, or anything you've enjoyed before — and I'll find the best match in stock.";
    return {
      reply,
      replyType: 'text',
      options: [],
      products: [],
      funnel: session.funnelState,
    };
  }

  session.funnelState = {
    phase: 'funnel',
    currentStepId: entry.id,
    candidateProductIds: [],
    parentExternalId: null,
    variantPath: [],
    path: [],
    preferenceHints: [],
  };

  const skipped = await resolvePastBrandSteps(store, session, entry, [], []);
  if (skipped) return skipped;

  return {
    reply: entry.prompt,
    replyType: 'options',
    options: formatOptionsForClient(entry),
    products: [],
    funnel: session.funnelState,
    stepId: entry.id,
  };
}

/**
 * Advance funnel based on user selection or free-text message.
 */
export async function advanceFunnel(store, session, userMessage, inventory) {
  const taxonomy = store.recommendationTaxonomy;
  let state = session.funnelState || {
    phase: 'funnel',
    currentStepId: taxonomy?.entryStepId || null,
    candidateProductIds: [],
    parentExternalId: null,
    variantPath: [],
    path: [],
  };

  if (state.phase === 'variant_refine') {
    return advanceVariantRefine(store, session, userMessage);
  }

  // Restart / free chat after final recommendation
  if (state.phase === 'recommendation' || state.phase === 'free_chat') {
    // Allow free chat after recommendation unless selecting another
  }

  const step = getTaxonomyStep(taxonomy, state.currentStepId);
  if (!step) {
    session.funnelState = { ...state, phase: 'free_chat' };
    return null; // signal caller to use classic GPT chat
  }

  // If an older taxonomy parked the user on a brand step, skip it before matching.
  let activeStep = step;
  if (isBrandStep(step)) {
    const resolved = advancePastBrandSteps(
      store,
      session,
      step,
      state.candidateProductIds || [],
      state.path || []
    );
    if (resolved.shouldRecommend) {
      const hints = (session.funnelState?.preferenceHints || []).filter(Boolean).join(' | ');
      return finalizeRecommendation(
        store,
        session,
        resolved.candidateProductIds,
        state.path || [],
        [userMessage, hints].filter(Boolean).join(' | ')
      );
    }
    activeStep = resolved.step;
    state = session.funnelState || state;
  }

  const option = matchOption(activeStep, userMessage);
  if (!option) {
    const hint = String(userMessage || '').trim();
    const preferenceHints = [
      ...(state.preferenceHints || []),
      ...(hint ? [hint] : []),
    ].slice(-8);

    // Already narrowed: free-text can finish with GPT over the current candidate pool.
    if (state.candidateProductIds?.length > 0) {
      session.funnelState = { ...state, preferenceHints };
      return finalizeRecommendation(
        store,
        session,
        state.candidateProductIds,
        state.path || [],
        preferenceHints.join(' | ')
      );
    }

    // Early funnel (e.g. "menthol" while still asking product type): keep chatting —
    // do NOT score the entire catalog (slow + poor UX for natural language).
    session.funnelState = {
      ...state,
      phase: 'funnel',
      currentStepId: activeStep.id,
      preferenceHints,
    };
    const examples = (activeStep.options || [])
      .slice(0, 5)
      .map((o) => o.label)
      .filter(Boolean);
    const exampleBit = examples.length ? ` For example: ${examples.join(', ')}.` : '';
    const ack = hint
      ? `Got it — I'll keep “${hint}” in mind.`
      : 'Happy to help.';
    return {
      reply: `${ack} ${activeStep.prompt || 'What type of product are you looking for?'}${exampleBit}`,
      replyType: 'options',
      options: formatOptionsForClient(activeStep),
      products: [],
      funnel: session.funnelState,
      stepId: activeStep.id,
    };
  }

  const nextPath = [
    ...(state.path || []),
    { stepId: activeStep.id || state.currentStepId, optionId: option.id, label: option.label },
  ];
  const candidateIds = (option.productIds || []).map(String);

  if (option.nextStepId) {
    const nextStep = getTaxonomyStep(taxonomy, option.nextStepId);
    if (nextStep) {
      // Intersect next-step options' products with chosen candidate set when possible
      const narrowedOptions = nextStep.options
        .map((opt) => {
          const ids = (opt.productIds || []).map(String).filter((id) => candidateIds.includes(id));
          // If taxonomy already scoped, keep original when intersection empty
          return {
            ...opt,
            productIds: ids.length
              ? ids
              : (opt.productIds || [])
                  .map(String)
                  .filter((id) => candidateIds.includes(id) || candidateIds.length === 0),
          };
        })
        .map((opt) => ({
          ...opt,
          productIds: opt.productIds?.length ? opt.productIds : (option.productIds || []).map(String),
        }))
        .filter((opt) => (opt.productIds || []).length > 0);

      const promptStep = {
        ...nextStep,
        options: narrowedOptions.length ? narrowedOptions : nextStep.options,
      };

      session.funnelState = {
        phase: 'funnel',
        currentStepId: nextStep.id,
        candidateProductIds: candidateIds,
        parentExternalId: null,
        variantPath: [],
        path: nextPath,
        preferenceHints: state.preferenceHints || [],
      };

      const skipped = await resolvePastBrandSteps(
        store,
        session,
        nextStep,
        candidateIds,
        nextPath
      );
      if (skipped) return skipped;

      return {
        reply: promptStep.prompt,
        replyType: 'options',
        options: formatOptionsForClient(promptStep),
        products: [],
        funnel: session.funnelState,
        stepId: nextStep.id,
      };
    }
  }

  // Leaf — produce recommendation (may continue into variant refine)
  const leafHints = [...(state.preferenceHints || [])].filter(Boolean).join(' | ');
  session.funnelState = {
    phase: 'funnel',
    currentStepId: state.currentStepId,
    candidateProductIds: candidateIds,
    parentExternalId: null,
    variantPath: [],
    path: nextPath,
    preferenceHints: state.preferenceHints || [],
  };
  return finalizeRecommendation(store, session, candidateIds, nextPath, leafHints);
}

export async function finalizeRecommendation(
  store,
  session,
  productIds,
  path = [],
  userHint = ''
) {
  const products = await loadProductsByIds(productIds);
  const pool = products.length
    ? products
    : await StoreInventory.find({ storeId: store._id, isActive: true }).limit(50).lean();

  const combinedHint = [
    userHint,
    ...(session.funnelState?.preferenceHints || []),
  ]
    .filter(Boolean)
    .join(' | ');

  const chosen = await pickBestProduct(store, pool, path, combinedHint);

  if (chosen) {
    const variantFlow = await startVariantRefine(store, session, chosen, path);
    if (variantFlow) return variantFlow;
  }

  return completeVariantRecommendation(store, session, chosen, path);
}

function buildRecommendationText(product) {
  const bits = [];
  if (product.brand) bits.push(product.brand);
  const parent = getParentDisplayName(product);
  const variant = getVariantLabel(product);
  if (parent && variant && parent.toLowerCase() !== variant.toLowerCase()) {
    bits.push(`${parent} — ${variant}`);
  } else {
    bits.push(product.name);
  }
  const nic =
    product.nicotineStrength ||
    (product.nicotineMgMl != null ? `${product.nicotineMgMl}mg` : null);
  const size = product.bottleSize || (product.volumeMl != null ? `${product.volumeMl}mL` : null);
  const specs = [nic, size].filter(Boolean).join(' · ');
  // Keep the spoken reply short — full marketing copy belongs on the product page / card blurb.
  return `Based on what you told me, I'd recommend ${bits.filter(Boolean).join(' — ')}${specs ? ` (${specs})` : ''}.`;
}

async function pickBestProduct(store, pool, path, userHint) {
  if (!pool.length) return null;
  const priority = pool.filter((p) => p.isPriorityPromotion);
  const candidates = priority.length ? priority : pool;

  if (!env.openai.apiKey || candidates.length === 1) {
    return candidates[0];
  }

  try {
    const pathText = path.map((p) => p.label).join(' → ');
    const listing = candidates.slice(0, 40).map((p, i) => ({
      index: i,
      id: String(p._id),
      name: p.name,
      brand: p.brand,
      flavor: p.flavor,
      variantName: p.variantName,
      description: p.description ? String(p.description).slice(0, 120) : null,
      nicotine: p.nicotineStrength,
      size: p.bottleSize,
      priority: Boolean(p.isPriorityPromotion),
    }));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.openai.model,
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Pick the single best inventory product for the customer based on their taste preferences (flavor, cooling/ice, sweetness, product type, overall experience). The customer may not know brands — choose the most suitable brand/product automatically from the candidates. Prefer PRIORITY items when they fit. Return JSON: {"productId":"...","reason":"short"}. Only use provided ids.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              store: store.name,
              selections: pathText,
              hint: userHint || null,
              candidates: listing,
            }),
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      const match = candidates.find((p) => String(p._id) === String(parsed.productId));
      if (match) return match;
    }
  } catch (error) {
    console.warn('[funnel] pickBestProduct GPT failed:', error.message);
  }

  return candidates[0];
}

export async function resetFunnel(store, session) {
  return beginFunnel(store, session);
}

export async function ensureStoreTaxonomy(storeId) {
  const store = await Store.findById(storeId);
  if (!store) return null;
  if (store.recommendationTaxonomyStatus === 'ready' && store.recommendationTaxonomy) {
    const { collapseBrandSteps, isBrandStep } = await import('./taxonomy.service.js');
    const steps = Object.values(store.recommendationTaxonomy.steps || {});
    if (steps.some((s) => isBrandStep(s))) {
      store.recommendationTaxonomy = collapseBrandSteps(store.recommendationTaxonomy);
      await store.save();
      console.log(`[taxonomy] Collapsed brand steps for store ${storeId}`);
    }
    return store;
  }
  try {
    const { buildAndStoreRecommendationTaxonomy } = await import('./taxonomy.service.js');
    await buildAndStoreRecommendationTaxonomy(storeId);
    return Store.findById(storeId);
  } catch (error) {
    console.warn('[funnel] ensureStoreTaxonomy failed:', error.message);
    return store;
  }
}
