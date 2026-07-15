import Store from '../models/Store.js';
import StoreInventory from '../models/StoreInventory.js';
import { env } from '../config/env.js';
import { getEntryStep, getTaxonomyStep } from './taxonomy.service.js';

/**
 * Dynamic GPT funnel helpers — step count and options come from store taxonomy.
 */

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
      path: [],
    };
    const reply =
      "Thanks for confirming. Tell me what flavors you like and I'll recommend from our current inventory.";
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
    path: [],
  };

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
  const state = session.funnelState || {
    phase: 'funnel',
    currentStepId: taxonomy?.entryStepId || null,
    candidateProductIds: [],
    path: [],
  };

  // Restart
  if (state.phase === 'recommendation' || state.phase === 'free_chat') {
    // Allow free chat after recommendation unless selecting another
  }

  const step = getTaxonomyStep(taxonomy, state.currentStepId);
  if (!step) {
    session.funnelState = { ...state, phase: 'free_chat' };
    return null; // signal caller to use classic GPT chat
  }

  const option = matchOption(step, userMessage);
  if (!option) {
    // Unmatched free text while in funnel — narrow via GPT recommendation over current candidates
    const poolIds =
      state.candidateProductIds?.length > 0
        ? state.candidateProductIds
        : inventory.map((p) => String(p._id));
    return finalizeRecommendation(store, session, poolIds, state.path || [], userMessage);
  }

  const nextPath = [
    ...(state.path || []),
    { stepId: state.currentStepId, optionId: option.id, label: option.label },
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
            productIds: ids.length ? ids : (opt.productIds || []).map(String).filter((id) => candidateIds.includes(id) || candidateIds.length === 0),
          };
        })
        .map((opt) => ({
          ...opt,
          productIds:
            opt.productIds?.length
              ? opt.productIds
              : (option.productIds || []).map(String),
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
        path: nextPath,
      };

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

  // Leaf — produce final recommendation from remaining products
  return finalizeRecommendation(store, session, candidateIds, nextPath);
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

  const chosen = await pickBestProduct(store, pool, path, userHint);
  const card = serializeProductCard(chosen);
  const reply = chosen
    ? buildRecommendationText(chosen)
    : "I couldn't find a perfect match in stock right now. Tell me another preference and I'll try again.";

  session.funnelState = {
    phase: 'recommendation',
    currentStepId: null,
    candidateProductIds: productIds.map(String),
    path,
  };

  return {
    reply,
    replyType: chosen ? 'recommendation' : 'text',
    options: [
      { id: 'another', label: 'Get Another Recommendation', emoji: '✨', value: 'Get Another Recommendation' },
    ],
    products: card ? [card] : [],
    funnel: session.funnelState,
  };
}

function buildRecommendationText(product) {
  const bits = [];
  if (product.brand) bits.push(product.brand);
  bits.push(product.name);
  const nic = product.nicotineStrength || (product.nicotineMgMl != null ? `${product.nicotineMgMl}mg` : null);
  const size = product.bottleSize || (product.volumeMl != null ? `${product.volumeMl}mL` : null);
  const specs = [nic, size].filter(Boolean).join(' · ');
  const desc = product.description
    ? ` ${String(product.description).replace(/\s+/g, ' ').trim().slice(0, 180)}`
    : '';
  return `Based on what you told me, I'd recommend ${bits.join(' — ')}${specs ? ` (${specs})` : ''}.${desc ? desc : ''} Please note that vaping products contain nicotine, which is addictive.`;
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
              'Pick the single best inventory product for the customer. Return JSON: {"productId":"...","reason":"short"}. Prefer PRIORITY items when they fit. Only use provided ids.',
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
