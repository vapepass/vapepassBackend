import { resolveSharedDescription, cleanDescription } from '../utils/descriptionOptimize.js';

const NICOTINE_RE = /(\d+(?:\.\d+)?)\s*mg(?:\s*\/?\s*m[lL])?/i;
const VOLUME_RE = /(\d+(?:\.\d+)?)\s*m[lL]\b/i;
const POD_HINT_RE = /\b(pod|cartridge|pre[- ]?filled|disposable)\b/i;
const BOTTLE_HINT_RE = /\b(e[- ]?liquid|e[- ]?juice|refill|bottle|salt\s*nic)\b/i;

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

  let productType = extras.productType || 'other';
  if (productType === 'other') {
    if (POD_HINT_RE.test(textForSpecs)) {
      productType = volumeMl != null && volumeMl <= 2 ? 'pod' : 'prefilled';
    } else if (BOTTLE_HINT_RE.test(textForSpecs) || (volumeMl != null && volumeMl > 2)) {
      productType = 'e_liquid';
    }
  }

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
        // Same parent PDP URL on every variant — open product page, never cart/checkout
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
      // Parent PDP URL when variant has no dedicated permalink
      productUrl: variant.permalink || productUrl,
      price: Number.isFinite(vPrice) ? vPrice : null,
    });
  });
}

function extractWooVariations(item) {
  if (Array.isArray(item.variations) && item.variations.length) {
    // Store API sometimes returns variation IDs only — skip until hydrated
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
