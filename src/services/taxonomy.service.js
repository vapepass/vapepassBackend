import Store from '../models/Store.js';
import StoreInventory from '../models/StoreInventory.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import { filterRecommendableProducts } from '../utils/compliance.js';

/**
 * Builds a dynamic recommendation hierarchy from store inventory using GPT.
 * Depth and options adapt to catalog size — never hardcoded.
 */

/** Keep GPT prompt small so JSON responses are not truncated on large stores */
const MAX_PRODUCTS_IN_PROMPT = 120;
const MAX_PRODUCTS_RETRY = 60;
const DESC_SNIPPET = 80;

async function loadRecommendable(storeId) {
  const products = await StoreInventory.find({ storeId, isActive: true })
    .sort({ isPriorityPromotion: -1, name: 1 })
    .lean();
  const compliant = filterRecommendableProducts(products);
  return compliant.sort((a, b) => {
    if (a.isPriorityPromotion && !b.isPriorityPromotion) return -1;
    if (!a.isPriorityPromotion && b.isPriorityPromotion) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });
}

function compactProduct(p) {
  return {
    id: String(p._id),
    name: p.name,
    brand: p.brand || undefined,
    flavor: p.flavor || undefined,
    category: p.category || undefined,
    subcategory: p.subcategory || undefined,
    variant: p.variantName || undefined,
    nicotine: p.nicotineStrength || (p.nicotineMgMl != null ? `${p.nicotineMgMl}mg` : undefined),
    size: p.bottleSize || (p.volumeMl != null ? `${p.volumeMl}mL` : undefined),
    productType: p.productType || undefined,
    description: p.description ? String(p.description).slice(0, DESC_SNIPPET) : undefined,
    priority: p.isPriorityPromotion ? true : undefined,
  };
}

/**
 * Sample diverse products for GPT — priority first, then spread across catalog.
 */
function sampleProductsForPrompt(products, limit = MAX_PRODUCTS_IN_PROMPT) {
  if (products.length <= limit) return products;
  const priority = products.filter((p) => p.isPriorityPromotion);
  const rest = products.filter((p) => !p.isPriorityPromotion);
  const selected = [...priority];
  const remainingSlots = Math.max(0, limit - selected.length);
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, remainingSlots)));
  for (let i = 0; i < rest.length && selected.length < limit; i += step) {
    selected.push(rest[i]);
  }
  // Fill leftovers
  for (let i = 0; i < rest.length && selected.length < limit; i += 1) {
    if (!selected.includes(rest[i])) selected.push(rest[i]);
  }
  return selected.slice(0, limit);
}

/**
 * Heuristic fallback taxonomy when OpenAI is unavailable.
 * First step = inventory type / category present in this store (dynamic).
 * Flavor/ice refinements only under liquid-like branches.
 */
export function buildHeuristicTaxonomy(products = []) {
  const byId = products.map((p) => String(p._id));
  if (!products.length) {
    return { entryStepId: null, steps: {}, version: 1, source: 'heuristic' };
  }

  if (products.length <= 2) {
    return {
      version: 1,
      source: 'heuristic',
      entryStepId: null,
      steps: {},
      autoRecommendProductIds: byId,
    };
  }

  const categoryMap = new Map();
  for (const p of products) {
    // Preference-friendly grouping — never top-level by brand (customers rarely know brands).
    const key = (
      inventoryTypeLabel(p) ||
      p.category ||
      p.subcategory ||
      p.productType ||
      'All products'
    )
      .toString()
      .trim();
    if (!categoryMap.has(key)) categoryMap.set(key, []);
    categoryMap.get(key).push(String(p._id));
  }

  // Cap top-level options for UX when catalog is huge
  const sortedEntries = [...categoryMap.entries()].sort((a, b) => b[1].length - a[1].length);
  const limited = sortedEntries.slice(0, 12);

  const steps = {};
  const entryId = 'step_main';
  const options = [];

  let i = 0;
  for (const [label, ids] of limited) {
    i += 1;
    const optionId = `opt_${i}`;
    let nextStepId = null;

    const subset = products.filter((p) => ids.includes(String(p._id)));
    const liquidLike = subset.some((p) => isLiquidLikeProduct(p));

    // Only offer ice/flavor refine for e-liquid / disposable / pouch style sets
    if (liquidLike) {
      const iceGroups = partitionByIce(subset);
      if (iceGroups.length >= 2 && subset.length >= 4) {
        nextStepId = `step_${optionId}_refine`;
        steps[nextStepId] = {
          id: nextStepId,
          prompt: 'Which style do you prefer?',
          options: iceGroups.map((g, idx) => ({
            id: `${optionId}_g${idx}`,
            label: g.label,
            emoji: g.emoji,
            productIds: g.ids,
            nextStepId: null,
          })),
        };
      }
    }

    options.push({
      id: optionId,
      label: label.slice(0, 40),
      emoji: guessEmoji(label),
      productIds: ids,
      nextStepId,
    });
  }

  steps[entryId] = {
    id: entryId,
    prompt:
      limited.length > 1
        ? 'What type of product are you looking for?'
        : 'What are you in the mood for?',
    options,
  };

  return { version: 1, source: 'heuristic', entryStepId: entryId, steps };
}

function inventoryTypeLabel(product) {
  const type = String(product?.productType || '').toLowerCase();
  const map = {
    e_liquid: 'E-Liquids',
    disposable: 'Disposable Vapes',
    device: 'Vape Kits & Devices',
    pod: 'Pod Systems',
    prefilled: 'Prefilled Pods',
    cartridge: 'Cartridges',
    coil: 'Coils',
    battery: 'Batteries',
    accessory: 'Accessories',
    pouch: 'Nicotine Pouches',
  };
  return map[type] || null;
}

function isLiquidLikeProduct(product) {
  const type = String(product?.productType || '').toLowerCase();
  if (['e_liquid', 'disposable', 'pouch', 'prefilled', 'pod'].includes(type)) return true;
  const hay = `${product?.category || ''} ${product?.name || ''}`.toLowerCase();
  return /\b(e[\s_-]?liquid|e[\s_-]?juice|disposables?|pouches?|flavor|flavour)\b/i.test(hay);
}

function partitionByIce(products) {
  const ice = [];
  const noIce = [];
  for (const p of products) {
    const hay = `${p.name} ${p.flavor || ''} ${p.description || ''}`.toLowerCase();
    if (/\b(ice|iced|frost|menthol|cool)\b/.test(hay)) ice.push(String(p._id));
    else noIce.push(String(p._id));
  }
  const groups = [];
  if (ice.length) groups.push({ label: 'Ice / Cooling', emoji: '❄️', ids: ice });
  if (noIce.length) groups.push({ label: 'No Ice', emoji: '🌿', ids: noIce });
  return groups;
}

function guessEmoji(label) {
  const t = label.toLowerCase();
  if (/disposables?|puff/.test(t)) return '🔋';
  if (/device|kit|mod|hardware/.test(t)) return '📱';
  if (/pod|cartridge/.test(t)) return '🧩';
  if (/coil/.test(t)) return '🔧';
  if (/batter/.test(t)) return '⚡';
  if (/chargers?|accessories|tank|glass/.test(t)) return '🛠️';
  if (/pouch/.test(t)) return '📦';
  if (/fruit|berry|mango|strawberry|citrus/.test(t)) return '🍓';
  if (/mint|menthol|ice|cool/.test(t)) return '🧊';
  if (/dessert|cream|sweet|candy|cake/.test(t)) return '🍰';
  if (/tobacco|classic/.test(t)) return '🍂';
  if (/salt/.test(t)) return '🧂';
  if (/freebase|e-?liquid|juice/.test(t)) return '💧';
  return '✨';
}

function tryParseJson(text) {
  if (!text) throw new Error('Empty JSON');
  try {
    return JSON.parse(text);
  } catch {
    // Repair common truncation: close open braces/brackets/quotes
    let repaired = text.trim();
    // Remove trailing incomplete key/value fragments after last complete object
    const lastBrace = Math.max(repaired.lastIndexOf('}'), repaired.lastIndexOf(']'));
    if (lastBrace > 0) repaired = repaired.slice(0, lastBrace + 1);

    const opens = (repaired.match(/\{/g) || []).length;
    const closes = (repaired.match(/\}/g) || []).length;
    const openArr = (repaired.match(/\[/g) || []).length;
    const closeArr = (repaired.match(/\]/g) || []).length;
    if (opens > closes) repaired += '}'.repeat(opens - closes);
    if (openArr > closeArr) repaired += ']'.repeat(openArr - closeArr);

    // Fix trailing commas
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(repaired);
  }
}

/**
 * Expand small GPT productId samples to full inventory by keyword match on option labels.
 */
function expandTaxonomyToFullInventory(taxonomy, inventory) {
  if (!taxonomy?.steps || !inventory?.length) return taxonomy;

  for (const step of Object.values(taxonomy.steps)) {
    if (!Array.isArray(step.options)) continue;
    for (const opt of step.options) {
      const label = String(opt.label || '').toLowerCase();
      const tokens = label
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !/^(the|and|with|for|ice)$/.test(t));
      if (!tokens.length) continue;

      const matched = inventory
        .filter((p) => {
          const hay = `${p.name} ${p.flavor || ''} ${p.category || ''} ${p.subcategory || ''} ${p.variantName || ''} ${p.description || ''}`.toLowerCase();
          return tokens.some((t) => hay.includes(t));
        })
        .map((p) => String(p._id));

      if (matched.length > (opt.productIds?.length || 0)) {
        const merged = new Set([...(opt.productIds || []).map(String), ...matched]);
        opt.productIds = [...merged];
      }
    }
  }
  return taxonomy;
}

function sanitizeTaxonomy(raw, validIds) {
  const valid = new Set(validIds.map(String));
  if (!raw || typeof raw !== 'object') return null;

  const stepsIn = raw.steps && typeof raw.steps === 'object' ? raw.steps : {};
  const steps = {};

  for (const [stepId, step] of Object.entries(stepsIn)) {
    if (!step || !Array.isArray(step.options)) continue;
    const options = step.options
      .map((opt, idx) => {
        const productIds = (opt.productIds || [])
          .map(String)
          .filter((id) => valid.has(id));
        if (!productIds.length) return null;
        return {
          id: String(opt.id || `opt_${idx}`),
          label: String(opt.label || 'Option').slice(0, 60),
          emoji: opt.emoji ? String(opt.emoji).slice(0, 8) : '✨',
          productIds,
          nextStepId: opt.nextStepId ? String(opt.nextStepId) : null,
        };
      })
      .filter(Boolean);

    if (!options.length) continue;
    steps[stepId] = {
      id: String(step.id || stepId),
      prompt: String(step.prompt || 'What sounds best?').slice(0, 200),
      options,
    };
  }

  for (const step of Object.values(steps)) {
    for (const opt of step.options) {
      if (opt.nextStepId && !steps[opt.nextStepId]) {
        opt.nextStepId = null;
      }
    }
  }

  let entryStepId = raw.entryStepId ? String(raw.entryStepId) : null;
  if (entryStepId && !steps[entryStepId]) {
    entryStepId = Object.keys(steps)[0] || null;
  }
  if (!entryStepId) {
    entryStepId = Object.keys(steps)[0] || null;
  }

  return collapseBrandSteps({
    version: 1,
    source: raw.source || 'gpt',
    entryStepId,
    steps,
    builtAt: new Date().toISOString(),
  });
}

/** True when a funnel step asks the customer to pick a brand/manufacturer. */
export function isBrandStep(step) {
  if (!step) return false;
  const hay = `${step.id || ''} ${step.prompt || ''}`.toLowerCase();
  return /\b(brand|brands|manufacturer|vendor|which make|preferred brand)\b/.test(hay);
}

/**
 * Remove brand-selection steps from the graph.
 * Customers should not need brand knowledge — AI picks brands from preferences + inventory.
 */
export function collapseBrandSteps(taxonomy) {
  if (!taxonomy?.steps || typeof taxonomy.steps !== 'object') return taxonomy;

  const steps = {};
  for (const [id, step] of Object.entries(taxonomy.steps)) {
    steps[id] = {
      ...step,
      options: (step.options || []).map((opt) => ({ ...opt })),
    };
  }

  const brandIds = new Set(
    Object.values(steps)
      .filter((s) => isBrandStep(s))
      .map((s) => s.id)
  );
  if (!brandIds.size) {
    return { ...taxonomy, steps };
  }

  for (const step of Object.values(steps)) {
    step.options = (step.options || []).map((opt) => {
      if (!opt.nextStepId || !brandIds.has(opt.nextStepId)) return opt;
      const brandStep = steps[opt.nextStepId];
      if (!brandStep?.options?.length) {
        return { ...opt, nextStepId: null };
      }

      const nexts = [
        ...new Set(brandStep.options.map((o) => o.nextStepId).filter(Boolean)),
      ];
      const unionIds = [
        ...new Set([
          ...(opt.productIds || []).map(String),
          ...brandStep.options.flatMap((o) => (o.productIds || []).map(String)),
        ]),
      ];

      if (nexts.length === 1) {
        return {
          ...opt,
          productIds: unionIds.length ? unionIds : opt.productIds,
          nextStepId: nexts[0],
        };
      }

      const preferenceNext = nexts.find((nid) => steps[nid] && !isBrandStep(steps[nid]));
      return {
        ...opt,
        productIds: unionIds.length ? unionIds : opt.productIds,
        nextStepId: preferenceNext || null,
      };
    });
  }

  let entryStepId = taxonomy.entryStepId ? String(taxonomy.entryStepId) : null;
  if (entryStepId && brandIds.has(entryStepId)) {
    const entry = steps[entryStepId];
    const nexts = [...new Set((entry?.options || []).map((o) => o.nextStepId).filter(Boolean))];
    if (nexts.length === 1 && steps[nexts[0]]) {
      entryStepId = nexts[0];
    }
  }

  for (const id of brandIds) {
    if (id !== entryStepId) delete steps[id];
  }

  // If entry is still a brand step, rewrite it into a preference prompt (options stay for matching).
  if (entryStepId && steps[entryStepId] && isBrandStep(steps[entryStepId])) {
    steps[entryStepId] = {
      ...steps[entryStepId],
      prompt:
        'What kind of experience are you looking for — fruity, menthol/ice, dessert, or something smooth?',
    };
  }

  return {
    ...taxonomy,
    entryStepId,
    steps,
  };
}

async function callGptTaxonomyOnce(products, { maxTokens = 3500 } = {}) {
  const payload = products.map(compactProduct);

  const system = `You are a recommendation UX architect for a vape retail shopping assistant.
Analyze the store inventory and build a dynamic multi-step preference funnel.

Rules:
- Do NOT use a fixed universal category list. Derive categories from THIS inventory only.
- When the inventory spans multiple product types (e-liquids, disposables, devices, pods, accessories, pouches, etc.), the FIRST step MUST ask what type of product the customer wants.
- NEVER ask the customer to choose a brand, manufacturer, vendor, or make. Customers usually do not know brands — the AI will select brands automatically from inventory.
- Later steps MUST refine by preference attributes only: flavor family (fruit, berry, tropical, citrus, dessert, candy, beverage, menthol), cooling/ice level, sweetness, nicotine strength (when relevant), or overall experience (smooth, strong, icy).
- Phrase prompts like an experienced store consultant (natural preference questions), not like a search form.
- Do not assume every customer wants e-liquids or flavors.
- Adapt depth to inventory size: small catalogs may need 1–2 steps; large catalogs may need more.
- Every option must include productIds that exist in the inventory id list.
- Prefer PRIORITY products (priority:true) when building option productIds.
- Keep productIds lists compact (max 25 ids per option) — pick representative matches.
- Never create empty options.
- Keep JSON SMALL and VALID. Prefer fewer steps over incomplete JSON.
- Return ONLY valid JSON matching the schema.`;

  const user = {
    instruction:
      'Build a compact preference-driven recommendation hierarchy. First question should determine product type when multiple types exist. Never include brand-selection steps. Return JSON with entryStepId and steps map. Keep response short.',
    schema: {
      entryStepId: 'string',
      steps: {
        step_id: {
          id: 'string',
          prompt: 'preference question shown to customer (never about brand)',
          options: [
            {
              id: 'string',
              label: 'string',
              emoji: 'optional',
              productIds: ['up to 25 inventory ids'],
              nextStepId: 'string|null',
            },
          ],
        },
      },
    },
    inventoryCount: products.length,
    inventory: payload,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.openai.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI taxonomy HTTP ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim();
  const finish = choice?.finish_reason;
  if (!text) throw new Error('Empty taxonomy response from OpenAI');

  try {
    return tryParseJson(text);
  } catch (error) {
    if (finish === 'length') {
      throw new Error(`Taxonomy JSON truncated (finish_reason=length): ${error.message}`);
    }
    throw new Error(`Taxonomy JSON parse failed: ${error.message}`);
  }
}

async function callGptTaxonomy(products) {
  // Attempt 1 — sampled catalog
  const sample = sampleProductsForPrompt(products, MAX_PRODUCTS_IN_PROMPT);
  try {
    return await callGptTaxonomyOnce(sample, { maxTokens: 3500 });
  } catch (error) {
    console.warn(`[taxonomy] GPT attempt 1 failed: ${error.message}`);
  }

  // Attempt 2 — smaller sample, more output room
  const smaller = sampleProductsForPrompt(products, MAX_PRODUCTS_RETRY);
  return callGptTaxonomyOnce(smaller, { maxTokens: 5000 });
}

/**
 * Build and persist recommendation taxonomy for a store after scrape.
 */
export async function buildAndStoreRecommendationTaxonomy(storeId) {
  const store = await Store.findById(storeId);
  if (!store) throw new ApiError(404, 'Store not found');

  store.recommendationTaxonomyStatus = 'building';
  store.recommendationTaxonomyError = null;
  await store.save();

  try {
    const inventory = await loadRecommendable(storeId);
    const validIds = inventory.map((p) => String(p._id));

    let taxonomy;
    if (!inventory.length) {
      taxonomy = { version: 1, source: 'empty', entryStepId: null, steps: {} };
    } else if (!env.openai.apiKey) {
      taxonomy = buildHeuristicTaxonomy(inventory);
    } else {
      try {
        const raw = await callGptTaxonomy(inventory);
        taxonomy = sanitizeTaxonomy({ ...raw, source: 'gpt' }, validIds);
        if (taxonomy?.entryStepId) {
          taxonomy = expandTaxonomyToFullInventory(taxonomy, inventory);
          taxonomy = sanitizeTaxonomy(taxonomy, validIds);
        }
        if (!taxonomy?.entryStepId) {
          taxonomy = buildHeuristicTaxonomy(inventory);
        }
      } catch (error) {
        console.warn(`[taxonomy] GPT build failed, using heuristic: ${error.message}`);
        taxonomy = buildHeuristicTaxonomy(inventory);
      }
    }

    store.recommendationTaxonomy = taxonomy;
    store.recommendationTaxonomyStatus = taxonomy.entryStepId || taxonomy.autoRecommendProductIds
      ? 'ready'
      : 'idle';
    store.recommendationTaxonomyBuiltAt = new Date();
    store.recommendationTaxonomyError = null;
    await store.save();

    console.log(
      `[taxonomy] Store ${storeId}: ${Object.keys(taxonomy.steps || {}).length} steps (${taxonomy.source})`
    );
    return taxonomy;
  } catch (error) {
    store.recommendationTaxonomyStatus = 'error';
    store.recommendationTaxonomyError = error.message?.slice(0, 1000) || 'Taxonomy build failed';
    await store.save();
    throw error;
  }
}

export function getTaxonomyStep(taxonomy, stepId) {
  if (!taxonomy?.steps || !stepId) return null;
  return taxonomy.steps[stepId] || null;
}

export function getEntryStep(taxonomy) {
  if (!taxonomy?.entryStepId) return null;
  return getTaxonomyStep(taxonomy, taxonomy.entryStepId);
}
