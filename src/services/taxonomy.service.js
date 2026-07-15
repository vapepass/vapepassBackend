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
 * Still dynamic from inventory fields — not a fixed flavor list.
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
    const key = (p.category || p.subcategory || p.flavor || p.brand || 'All products').trim();
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
    prompt: 'What are you in the mood for?',
    options,
  };

  return { version: 1, source: 'heuristic', entryStepId: entryId, steps };
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

  return {
    version: 1,
    source: raw.source || 'gpt',
    entryStepId,
    steps,
    builtAt: new Date().toISOString(),
  };
}

async function callGptTaxonomyOnce(products, { maxTokens = 3500 } = {}) {
  const payload = products.map(compactProduct);

  const system = `You are a recommendation UX architect for a vape retail chatbot.
Analyze the store inventory and build a dynamic multi-step selection funnel.

Rules:
- Do NOT use a fixed universal category list. Derive categories from THIS inventory only.
- Adapt depth to inventory size: small catalogs may need 1–2 steps; large catalogs may need more.
- Every option must include productIds that exist in the inventory id list.
- Keep productIds lists compact (max 25 ids per option) — pick representative matches.
- Never create empty options.
- Keep JSON SMALL and VALID. Prefer fewer steps over incomplete JSON.
- Return ONLY valid JSON matching the schema.`;

  const user = {
    instruction:
      'Build a compact recommendation hierarchy. Return JSON with entryStepId and steps map. Keep response short.',
    schema: {
      entryStepId: 'string',
      steps: {
        step_id: {
          id: 'string',
          prompt: 'question shown to customer',
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
