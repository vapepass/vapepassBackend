import { resolveSharedDescription, cleanDescription } from '../utils/descriptionOptimize.js';

const NICOTINE_RE = /(\d+(?:\.\d+)?)\s*mg(?:\s*\/?\s*m[lL])?/i;
const VOLUME_RE = /(\d+(?:\.\d+)?)\s*m[lL]\b/i;
const POD_HINT_RE = /\b(pod|cartridge|pre[- ]?filled)\b/i;
const DISPOSABLE_HINT_RE =
  /\b(disposable\s*vapes?|disposables?|puff\s*bar|vape\s*bar|\d{1,3}\s*k\s*puffs?|\d{1,3}(?:,\d{3})+\s*puffs?|up\s*to\s*\d[\d,]*\s*puffs?)\b/i;
const CARTRIDGE_HINT_RE =
  /\b(510|empty\s*cart|empty\s*cartridge|cartridges?|atomizers?)\b/i;
const DEVICE_HINT_RE =
  /\b(vape\s*kits?|starter\s*kits?|mods?\b|devices?|tanks?|atomizers?|box\s*mod)\b/i;
const HARDWARE_HINT_RE =
  /\b(coils?|batter(?:y|ies)|chargers?|drip\s*tips?|glass(?:ware)?|replacement\s*parts?|accessories)\b/i;
const POUCH_HINT_RE = /\b(nicotine\s*pouches?|pouches?)\b/i;
const BOTTLE_HINT_RE = /\b(e[- ]?liquid|e[- ]?juice|refill|bottle|salt\s*nic|freebase|nic\s*salt)\b/i;

/**
 * Flexible match for E-Liquids section names (still used for typing / emoji).
 */
export const ELIQUID_CATEGORY_RE =
  /\b(e[\s_-]?liquids?|e[\s_-]?juices?|vape[\s_-]?juices?|vape[\s_-]?liquids?)\b/i;

/**
 * Categories that are NOT part of the retail vape catalog (food, apparel, etc.).
 * Hardware, disposables, pods, pouches, and accessories ARE scraped.
 */
export const NON_CATALOG_CATEGORY_RE =
  /\b(snacks?|beverages?|drinks?|food|apparel|clothing|novelties|lighters?|torches?|ashtrays?|cigars?|cigarettes?\b|bongs?|rigs?|pipes?\b|rolling|papers?|grinders?|hookah|shisha|herbal|vaporizers?\b(?![\s_-]*pen)|cbd)\b/i;

/** @deprecated Use NON_CATALOG_CATEGORY_RE — kept for older imports/tests */
export const EXCLUDED_NON_ELIQUID_CATEGORY_RE = NON_CATALOG_CATEGORY_RE;

/** True when a category / collection / product-type name is the E-Liquids section. */
export function isELiquidCategoryName(name) {
  if (!name) return false;
  return ELIQUID_CATEGORY_RE.test(String(name).replace(/[_-]+/g, ' ').trim());
}

/**
 * True for store sections we intentionally skip (snacks, apparel, cigars, …).
 * Does NOT exclude Devices, Pods, Disposables, Accessories, Pouches, etc.
 */
export function isExcludedNonELiquidCategory(name) {
  return isNonCatalogCategory(name);
}

export function isNonCatalogCategory(name) {
  if (!name) return false;
  const normalized = String(name).replace(/[_-]+/g, ' ').trim();
  // Never treat e-liquid style names as non-catalog
  if (isELiquidCategoryName(normalized)) return false;
  return NON_CATALOG_CATEGORY_RE.test(normalized);
}

/**
 * Keep inventory rows that belong in the store catalog (full inventory).
 * Rejects only clear non-catalog sections (food, apparel, cigars, …).
 */
export function isCatalogProduct(product = {}) {
  const category = product.category || '';
  const subcategory = product.subcategory || '';
  const name = product.name || '';

  if (isNonCatalogCategory(category)) return false;
  if (isNonCatalogCategory(subcategory)) return false;
  // Title-only junk (e.g. snack SKUs miscategorized) — only drop when category is empty
  if (!category && !subcategory && isNonCatalogCategory(name)) return false;
  if (!String(name || product.variantName || '').trim()) return false;
  return true;
}

/**
 * @deprecated Prefer isCatalogProduct — kept for tests / callers that checked e-liquid membership.
 * Now accepts any catalog product (full inventory).
 */
export function isLikelyELiquidProduct(product = {}) {
  return isCatalogProduct(product);
}

/**
 * Keep the storefront product URL intact — only trim / cap length.
 * Blocks dangerous schemes so "View Product" stays a safe new-tab open.
 */
export function sanitizeProductPageUrl(url) {
  if (url == null) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return null;
  return trimmed.length > 2048 ? trimmed.slice(0, 2048) : trimmed;
}

export function inferProductType(extras = {}, textForSpecs = '') {
  const hay = `${extras.category || ''} ${extras.subcategory || ''} ${textForSpecs}`.toLowerCase();

  // Disposables / empty carts first — often sit in wrong Shopify product_type buckets
  if (DISPOSABLE_HINT_RE.test(hay)) return 'disposable';
  if (CARTRIDGE_HINT_RE.test(hay)) return 'cartridge';

  if (extras.productType && extras.productType !== 'other') {
    // Override mis-labeled e_liquid when the title is clearly a disposable / empty cart
    if (extras.productType === 'e_liquid' && DISPOSABLE_HINT_RE.test(hay)) return 'disposable';
    if (extras.productType === 'e_liquid' && CARTRIDGE_HINT_RE.test(hay)) return 'cartridge';
    return extras.productType;
  }

  if (
    isELiquidCategoryName(extras.category) ||
    isELiquidCategoryName(extras.subcategory) ||
    BOTTLE_HINT_RE.test(hay)
  ) {
    return 'e_liquid';
  }
  if (POUCH_HINT_RE.test(hay)) return 'pouch';
  if (POD_HINT_RE.test(hay)) {
    // Empty / replacement mesh pods are hardware — not flavored closed pods
    if (
      /\b\d+(?:\.\d+)?\s*ohm\b/i.test(hay) ||
      /\b(mesh\s*pod|empty\s*pod|replacement\s*pod|refillable\s*pod)\b/i.test(hay)
    ) {
      return 'pod';
    }
    if (/\bpre-?filled\b/i.test(hay)) return 'prefilled';
    const volumeMatch = textForSpecs.match(VOLUME_RE);
    const volumeMl = volumeMatch ? Number(volumeMatch[1]) : null;
    const flavorish =
      /\b(mango|berry|strawberry|blueberry|watermelon|grape|peach|lemon|lime|orange|mint|menthol|vanilla|candy|ice|iced|tropical|melon|apple|banana|pineapple|coconut|cherry)\b/i.test(
        hay
      );
    if (flavorish) return 'prefilled';
    if (volumeMl != null && volumeMl <= 2) return 'pod';
    return 'pod';
  }
  if (DEVICE_HINT_RE.test(hay)) return 'device';
  if (HARDWARE_HINT_RE.test(hay)) return 'accessory';
  if (/\bcoil/i.test(hay)) return 'coil';
  if (/\bbatter/i.test(hay)) return 'battery';

  const volumeMatch = textForSpecs.match(VOLUME_RE);
  const volumeMl = volumeMatch ? Number(volumeMatch[1]) : null;
  if (volumeMl != null && volumeMl > 2) return 'e_liquid';

  return 'other';
}

/**
 * Build a rich inventory row (one purchasable variant = one product).
 */
export function buildRichProduct(title, productUrl, extras = {}) {
  const textForSpecs = extras.textForSpecs || [
    title,
    extras.variantName,
    extras.category,
    extras.subcategory,
    extras.description,
  ]
    .filter(Boolean)
    .join(' ');

  const nicotineMatch = textForSpecs.match(NICOTINE_RE);
  const volumeMatch = textForSpecs.match(VOLUME_RE);
  const nicotineMgMl = nicotineMatch ? Number(nicotineMatch[1]) : null;
  const volumeMl = volumeMatch ? Number(volumeMatch[1]) : null;

  const productType = inferProductType(extras, textForSpecs);

  const { brand, flavor } = splitBrandFlavor(title, extras.brand);
  const platform = extras.platform || 'generic';
  const resolvedUrl = sanitizeProductPageUrl(productUrl || extras.productUrl);
  const externalId =
    extras.externalId || `gen:${(resolvedUrl || title).toLowerCase().slice(0, 180)}`;

  const nicotineStrength =
    extras.nicotineStrength ||
    (Number.isFinite(nicotineMgMl) ? `${nicotineMgMl}mg` : null);
  const bottleSize =
    extras.bottleSize || (Number.isFinite(volumeMl) ? `${volumeMl}mL` : null);

  return {
    name: cleanText(title).slice(0, 300),
    brand,
    flavor,
    description: extras.description || null,
    descriptionHash: extras.descriptionHash || null,
    descriptionSource: extras.descriptionSource || null,
    imageUrl: extras.imageUrl || null,
    category: extras.category ? cleanText(extras.category).slice(0, 160) : null,
    subcategory: extras.subcategory ? cleanText(extras.subcategory).slice(0, 160) : null,
    variantName: extras.variantName ? cleanText(extras.variantName).slice(0, 200) : null,
    parentExternalId: extras.parentExternalId || null,
    nicotineMgMl: Number.isFinite(nicotineMgMl) ? nicotineMgMl : null,
    nicotineStrength,
    volumeMl: Number.isFinite(volumeMl) ? volumeMl : null,
    bottleSize,
    price: Number.isFinite(Number(extras.price)) ? Number(extras.price) : null,
    productType,
    /** Original product page URL on the client storefront */
    productUrl: resolvedUrl,
    externalId,
    platform,
  };
}

export function explodeShopifyProduct(item, origin, taxonomy = {}, descriptionPool = new Map()) {
  const title = cleanText(item.title || '');
  if (!title) return [];

  const handle = item.handle || String(item.id);
  const productUrl = `${origin}/products/${handle}`;
  const parentExternalId = `shopify:${handle}`;
  const rawDesc = cleanDescription(item.body_html || item.description || '');
  const desc = resolveSharedDescription(
    rawDesc,
    taxonomy.subcategoryDescription,
    taxonomy.categoryDescription,
    descriptionPool
  );
  const imageUrl =
    item.images?.[0]?.src || item.image?.src || item.featured_image || null;

  const category = taxonomy.category || item.product_type || null;
  const subcategory = taxonomy.subcategory || null;
  const variants = Array.isArray(item.variants) && item.variants.length ? item.variants : [null];
  const products = [];

  for (const variant of variants) {
    const variantTitle =
      variant && variant.title && !/^default title$/i.test(variant.title)
        ? cleanText(variant.title)
        : null;

    const name = variantTitle ? `${title} - ${variantTitle}` : title;
    const optionText = [variant?.option1, variant?.option2, variant?.option3]
      .filter(Boolean)
      .join(' ');
    const textForSpecs = `${title} ${variantTitle || ''} ${optionText} ${item.product_type || ''} ${item.vendor || ''} ${desc.description || ''}`;

    products.push(
      buildRichProduct(name, productUrl, {
        brand: item.vendor || null,
        externalId: variant?.id != null ? `shopify:${handle}:${variant.id}` : parentExternalId,
        parentExternalId,
        platform: 'shopify',
        textForSpecs,
        description: desc.description,
        descriptionHash: desc.descriptionHash,
        descriptionSource: desc.descriptionSource,
        imageUrl: variant?.featured_image?.src || imageUrl,
        category,
        subcategory,
        variantName: variantTitle,
        productUrl,
        price: variant?.price != null ? Number(variant.price) : null,
      })
    );
  }

  return products;
}

export function explodeWooProduct(item, origin, taxonomy = {}, descriptionPool = new Map()) {
  const title = cleanText(item.name || item.title?.rendered || item.title || '');
  if (!title) return [];

  const id = item.id != null ? String(item.id) : title.toLowerCase();
  const productUrl = item.permalink || item.link || `${origin}/?p=${id}`;
  const parentExternalId = `woo:${id}`;
  const rawDesc = cleanDescription(
    item.description || item.short_description || item.content?.rendered || ''
  );
  const desc = resolveSharedDescription(
    rawDesc,
    taxonomy.subcategoryDescription,
    taxonomy.categoryDescription,
    descriptionPool
  );
  const imageUrl =
    item.images?.[0]?.src ||
    item.images?.[0]?.thumbnail ||
    item.image?.src ||
    null;

  const category =
    taxonomy.category ||
    item.categories?.[0]?.name ||
    item.categories?.[0]?.label ||
    null;
  const subcategory =
    taxonomy.subcategory ||
    item.categories?.[1]?.name ||
    null;

  const variations = extractWooVariations(item);
  if (!variations.length) {
    const price =
      item.prices?.price != null
        ? Number(item.prices.price) / (item.prices.currency_minor_unit != null ? 10 ** item.prices.currency_minor_unit : 100)
        : item.price != null
          ? Number(item.price)
          : null;

    return [
      buildRichProduct(title, productUrl, {
        brand: item.brands?.[0]?.name || null,
        externalId: parentExternalId,
        parentExternalId,
        platform: 'woocommerce',
        textForSpecs: `${title} ${rawDesc || ''}`,
        description: desc.description,
        descriptionHash: desc.descriptionHash,
        descriptionSource: desc.descriptionSource,
        imageUrl,
        category,
        subcategory,
        price: Number.isFinite(price) ? price : null,
      }),
    ];
  }

  return variations.map((variant) => {
    const variantTitle = cleanText(variant.name || variant.attributes_summary || variantTitleFromAttrs(variant));
    const name = variantTitle && !variantTitle.toLowerCase().includes(title.toLowerCase())
      ? `${title} - ${variantTitle}`
      : variantTitle || title;
    const vid = variant.id != null ? String(variant.id) : `${id}:${variantTitle}`;
    const vPrice =
      variant.prices?.price != null
        ? Number(variant.prices.price) /
          (variant.prices.currency_minor_unit != null
            ? 10 ** variant.prices.currency_minor_unit
            : 100)
        : variant.price != null
          ? Number(variant.price)
          : null;

    return buildRichProduct(name, variant.permalink || productUrl, {
      brand: item.brands?.[0]?.name || null,
      externalId: `woo:${id}:var:${vid}`,
      parentExternalId,
      platform: 'woocommerce',
      textForSpecs: `${title} ${variantTitle} ${rawDesc || ''}`,
      description: desc.description,
      descriptionHash: desc.descriptionHash,
      descriptionSource: desc.descriptionSource,
      imageUrl: variant.image?.src || imageUrl,
      category,
      subcategory,
      variantName: variantTitle || null,
      productUrl: variant.permalink || productUrl,
      price: Number.isFinite(vPrice) ? vPrice : null,
    });
  });
}

function extractWooVariations(item) {
  if (Array.isArray(item.variations) && item.variations.length) {
    if (typeof item.variations[0] === 'object' && item.variations[0]?.id != null) {
      return item.variations.filter((v) => typeof v === 'object');
    }
  }
  if (Array.isArray(item.attributes) && item.type === 'simple') return [];
  return [];
}

function variantTitleFromAttrs(variant) {
  if (Array.isArray(variant.attributes)) {
    return variant.attributes.map((a) => a.option || a.name).filter(Boolean).join(' / ');
  }
  return '';
}

function splitBrandFlavor(title, knownBrand = null) {
  const cleaned = title
    .replace(NICOTINE_RE, '')
    .replace(VOLUME_RE, '')
    .replace(/\b(pod|cartridge|disposable|e-?liquid|e-?juice|salt\s*nic)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (knownBrand) {
    return {
      brand: String(knownBrand).trim(),
      flavor:
        cleaned
          .replace(new RegExp(`^${escapeRegExp(String(knownBrand))}\\s*[-–:]?\\s*`, 'i'), '')
          .trim() || cleaned,
    };
  }

  const parts = cleaned.split(/\s[-–|]\s/);
  if (parts.length >= 2) {
    return { brand: parts[0].trim(), flavor: parts.slice(1).join(' - ').trim() };
  }

  const words = cleaned.split(/\s+/);
  if (words.length >= 3) {
    return { brand: words[0], flavor: words.slice(1).join(' ') };
  }

  return { brand: null, flavor: cleaned || null };
}

function cleanText(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
