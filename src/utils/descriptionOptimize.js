import crypto from 'crypto';

/**
 * Shared-description helpers — reuse identical product/category text across variants.
 */

export function hashDescription(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/**
 * Prefer product description; fall back to subcategory then category text.
 * Deduplicates identical strings via an in-memory pool for the scrape run.
 *
 * @param {string|null} productDescription
 * @param {string|null} subcategoryDescription
 * @param {string|null} categoryDescription
 * @param {Map<string, string>} pool hash -> canonical text
 */
export function resolveSharedDescription(
  productDescription,
  subcategoryDescription,
  categoryDescription,
  pool = new Map()
) {
  const candidates = [
    { text: cleanDescription(productDescription), source: 'product' },
    { text: cleanDescription(subcategoryDescription), source: 'subcategory' },
    { text: cleanDescription(categoryDescription), source: 'category' },
  ].filter((c) => c.text);

  if (!candidates.length) {
    return { description: null, descriptionHash: null, descriptionSource: null };
  }

  const chosen = candidates[0];
  const hash = hashDescription(chosen.text);
  if (!hash) {
    return { description: null, descriptionHash: null, descriptionSource: null };
  }

  if (pool.has(hash)) {
    return {
      description: pool.get(hash),
      descriptionHash: hash,
      descriptionSource: 'shared',
    };
  }

  pool.set(hash, chosen.text);
  return {
    description: chosen.text,
    descriptionHash: hash,
    descriptionSource: chosen.source,
  };
}

export function cleanDescription(htmlOrText) {
  if (!htmlOrText) return null;
  return String(htmlOrText)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000) || null;
}
