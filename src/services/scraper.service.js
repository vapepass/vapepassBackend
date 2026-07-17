import dns from 'dns';
import https from 'https';
import http from 'http';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import { cleanDescription } from '../utils/descriptionOptimize.js';
import {
  buildRichProduct,
  explodeShopifyProduct,
  explodeWooProduct,
  isELiquidCategoryName,
  isExcludedNonELiquidCategory,
  isLikelyELiquidProduct,
} from './scraper.catalog.js';

export {
  isELiquidCategoryName,
  isExcludedNonELiquidCategory,
  isLikelyELiquidProduct,
} from './scraper.catalog.js';

// Prefer IPv4 — avoids ConnectTimeoutError on some Windows/network setups
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Node < 17
}

const httpAgent = new http.Agent({ family: 4, keepAlive: true });
const httpsAgent = new https.Agent({ family: 4, keepAlive: true });

const NICOTINE_RE = /(\d+(?:\.\d+)?)\s*mg(?:\s*\/?\s*m[lL])?/i;
const VOLUME_RE = /(\d+(?:\.\d+)?)\s*m[lL]\b/i;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1200;
/** Cap after variant explosion — supports large multi-variant catalogs */
const MAX_PRODUCTS = 5000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Skip ScrapingBee for the rest of the process after quota / auth failures */
let scrapingBeeDisabled = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with exponential backoff retries.
 * Honors HTTP 429 with longer waits; does not thrash on permanent 401/403.
 */
async function withRetry(label, fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const status = error.status || error.statusCode;
      const clientError =
        status && status >= 400 && status < 500 && status !== 429;
      const connectError = /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|Connect Timeout/i.test(
        error.message || ''
      );
      const quotaError = /Monthly API calls limit|quota|credits/i.test(
        error.message || ''
      );
      console.warn(
        `[scraper] ${label} attempt ${attempt}/${retries} failed: ${error.message}`
      );
      if (quotaError || clientError || connectError || attempt >= retries) break;
      const retryAfterMs =
        status === 429
          ? Math.max(5000, RETRY_BASE_MS * 3 * attempt)
          : RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(retryAfterMs);
    }
  }
  throw lastError;
}

/**
 * Detect e-commerce platform from HTML / headers / URL patterns.
 */
export function detectPlatform(html = '', url = '') {
  const haystack = `${html}\n${url}`.toLowerCase();

  if (
    haystack.includes('cdn.shopify.com') ||
    haystack.includes('shopify.theme') ||
    haystack.includes('shopify-section') ||
    haystack.includes('myshopify.com') ||
    /\/products\.json/i.test(url)
  ) {
    return 'shopify';
  }

  if (
    haystack.includes('woocommerce') ||
    haystack.includes('wp-content/plugins/woocommerce') ||
    haystack.includes('wc-block') ||
    haystack.includes('wp-json/wc/') ||
    haystack.includes('wp-content/themes')
  ) {
    return 'woocommerce';
  }

  return 'generic';
}

function originOf(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeStoreUrl(url) {
  if (!url) throw new ApiError(400, 'Store website URL is required');

  let withProtocol = String(url).trim();
  if (!/^https?:\/\//i.test(withProtocol)) {
    withProtocol = `https://${withProtocol}`;
  }

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new ApiError(400, 'Invalid store website URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(400, 'Store website URL must use http or https');
  }

  return parsed.toString();
}

/**
 * Fetch HTML via ScrapingBee (preferred), direct HTTP, or Playwright.
 */
export async function fetchPageHtml(url) {
  const normalized = normalizeStoreUrl(url);

  if (env.scrapingBee.apiKey && !scrapingBeeDisabled) {
    try {
      return await withRetry('ScrapingBee', () => fetchWithScrapingBee(normalized));
    } catch (error) {
      if (/Monthly API calls limit|401|403|quota|credits/i.test(error.message || '')) {
        scrapingBeeDisabled = true;
        console.warn(
          '[scraper] ScrapingBee disabled for this process (quota/auth). Using direct fetch / Playwright.'
        );
      } else {
        console.error('[scraper] ScrapingBee exhausted retries, trying direct fetch:', error.message);
      }
    }
  }

  try {
    return await withRetry('Direct HTML', () => fetchHtmlDirect(normalized));
  } catch (error) {
    console.warn(`[scraper] Direct HTML fetch failed: ${error.message}`);
  }

  return withRetry('Playwright', () => fetchWithPlaywright(normalized));
}

async function fetchHtmlDirect(url) {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    45000
  );

  if (!response.ok) {
    const error = new Error(`HTML fetch HTTP ${response.status} for ${url}`);
    error.status = response.status;
    throw error;
  }

  const html = await response.text();
  if (!html || html.length < 40) {
    throw new Error(`Empty HTML response for ${url}`);
  }
  return html;
}

async function fetchWithScrapingBee(url) {
  const endpoint = new URL('https://app.scrapingbee.com/api/v1/');
  endpoint.searchParams.set('api_key', env.scrapingBee.apiKey);
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('render_js', 'true');
  endpoint.searchParams.set('premium_proxy', 'true');
  endpoint.searchParams.set('country_code', 'ca');
  endpoint.searchParams.set('wait', '2000');
  endpoint.searchParams.set('block_resources', 'false');

  const response = await fetchWithTimeout(endpoint.toString(), {
    method: 'GET',
    headers: { Accept: 'text/html' },
  }, 60000);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`ScrapingBee HTTP ${response.status}: ${body.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }

  return response.text();
}

async function fetchWithPlaywright(url) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new ApiError(
      503,
      'No scraper available. Set SCRAPINGBEE_API_KEY or install Playwright browsers.'
    );
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

/**
 * Direct JSON fetch (no browser) — used for Shopify / WooCommerce APIs.
 * Uses a browser User-Agent; Shopify rate-limits obvious bots aggressively.
 */
async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    const error = new Error(`JSON fetch HTTP ${response.status} for ${url}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  try {
    return await nodeHttpRequest(url, options, timeoutMs);
  } catch (error) {
    // Fallback to global fetch if native request fails unexpectedly
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Native http(s) request forced to IPv4 — more reliable than undici on some networks.
 */
function nodeHttpRequest(url, options = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = { ...(options.headers || {}) };

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: timeoutMs,
        family: 4,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const body = buffer.toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Intelligent Shopify crawl — E-Liquids section only:
 * 1) Locate E-Liquids collection(s) by name (E-Liquid, E-Juice, Freebase E-Liquid, …)
 * 2) Scrape each matching collection (products + variants)
 * 3) Never scrape Tobacco, Cigars, Disposables, Devices, Snacks, or other sections
 * 4) If no E-Liquids collection exists → return empty (caller raises a clear error)
 */
export async function scrapeShopify(storeUrl) {
  const origin = originOf(storeUrl);
  const products = [];
  const seen = new Set();
  const descriptionPool = new Map();

  console.log(`[scraper] Shopify E-Liquids-only crawl: ${origin}`);

  let collections = [];
  try {
    collections = await fetchShopifyCollections(origin, 40);
  } catch (error) {
    console.warn(`[scraper] Shopify collections fetch failed: ${error.message}`);
  }

  const { targets, reason } = await buildShopifyELiquidTargets(origin, collections);

  if (!targets.length) {
    console.warn(
      `[scraper] No E-Liquids collection found on Shopify store (${reason || 'none'})`
    );
    return [];
  }

  console.log(
    `[scraper] Shopify: processing ${targets.length} E-Liquids collection(s) only`
  );

  for (const target of targets) {
    if (products.length >= MAX_PRODUCTS) break;
    try {
      await sleep(300);
      const batch = await fetchShopifyCollectionProducts(origin, target.handle);
      console.log(
        `[scraper] Shopify "${target.category}"${
          target.subcategory ? ` → ${target.subcategory}` : ''
        }: ${batch.length} parent products`
      );

      for (const item of batch) {
        if (item.status && item.status !== 'active') continue;
        if (!shopifyItemBelongsToELiquid(item, target)) continue;

        const exploded = explodeShopifyProduct(
          item,
          origin,
          {
            category: target.category,
            subcategory: target.subcategory,
            categoryDescription: target.categoryDescription,
            subcategoryDescription: target.subcategoryDescription,
          },
          descriptionPool
        );
        for (const row of exploded) {
          if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
          seen.add(row.externalId);
          products.push(row);
        }
      }
    } catch (error) {
      console.warn(
        `[scraper] Shopify E-Liquids target failed (${target.handle}): ${error.message}`
      );
    }
  }

  console.log(
    `[scraper] Shopify: ${products.length} E-Liquid variant-level products from ${origin}`
  );
  return products;
}

/**
 * Build scrape targets for the E-Liquids section only.
 *
 * Shopify collections are flat. Only collections whose title/handle match
 * E-Liquids naming (E-Liquid, E-Juice, Vape Juice, Salt Nic E-Liquid, …)
 * are scraped. Unrelated collections are never added as "subcategories".
 */
async function buildShopifyELiquidTargets(_origin, collections) {
  const roots = collections.filter((c) => {
    const title = c.title || c.handle || '';
    if (!isValidShopifyCollectionHandle(c.handle)) return false;
    if (isExcludedNonELiquidCategory(title) || isExcludedNonELiquidCategory(c.handle)) {
      return false;
    }
    return isELiquidCategoryName(title);
  });

  if (!roots.length) {
    return { targets: [], reason: 'no_eliquid_collection' };
  }

  const targets = [];
  const seenHandles = new Set();

  for (const root of roots) {
    const key = String(root.handle || '').toLowerCase();
    if (!key || seenHandles.has(key)) continue;
    seenHandles.add(key);
    targets.push({
      handle: root.handle,
      category: cleanText(root.title || root.handle || 'E-Liquids'),
      subcategory: null,
      categoryDescription: cleanDescription(root.body_html || ''),
      subcategoryDescription: null,
    });
  }

  return { targets, reason: null };
}

/** Shopify handles are slug-like; reject feed suffixes (.atom, .oembed) and junk. */
function isValidShopifyCollectionHandle(handle) {
  const h = String(handle || '').trim();
  if (!h || h.length > 120) return false;
  if (/\./.test(h)) return false;
  if (/^(all|frontpage)$/i.test(h)) return false;
  return /^[a-z0-9][a-z0-9-]*$/i.test(h);
}

const BOTTLE_HINT_RE_LOCAL = /\b(e[- ]?liquid|e[- ]?juice|refill|bottle|salt\s*nic|freebase|nic\s*salt)\b/i;

function shopifyItemBelongsToELiquid(item, target = {}) {
  const productType = item.product_type || '';
  const tags = String(item.tags || '');
  const title = item.title || '';
  const haystack = `${productType} ${tags} ${title}`;

  // Hard reject tobacco / hardware / snacks even if they appear inside an E-Liquids collection
  if (isExcludedNonELiquidCategory(productType)) return false;
  if (isExcludedNonELiquidCategory(title) && !BOTTLE_HINT_RE_LOCAL.test(haystack)) return false;

  const excludedTag = String(tags)
    .split(',')
    .map((t) => t.trim())
    .find((t) => t && isExcludedNonELiquidCategory(t) && !isELiquidCategoryName(t));
  if (excludedTag && !isELiquidCategoryName(productType) && !BOTTLE_HINT_RE_LOCAL.test(title)) {
    return false;
  }

  // Inside an explicit E-Liquids collection target — trust membership after hard rejects
  if (target.category && isELiquidCategoryName(target.category)) {
    return true;
  }

  return isELiquidCategoryName(productType) || BOTTLE_HINT_RE_LOCAL.test(haystack);
}

async function fetchShopifyCollections(origin, maxPages = 10) {
  const collections = [];
  let page = 1;
  while (page <= maxPages) {
    const endpoint = `${origin}/collections.json?limit=250&page=${page}`;
    let data;
    try {
      data = await withRetry(`Shopify collections page ${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
    const batch = Array.isArray(data?.collections) ? data.collections : [];
    if (!batch.length) break;
    collections.push(...batch);
    if (batch.length < 250) break;
    page += 1;
    await sleep(300);
  }
  return collections.filter((c) => c.handle && !/^frontpage$/i.test(c.handle));
}

async function fetchShopifyCollectionProducts(origin, handle, maxPages = 20) {
  const products = [];
  let page = 1;
  while (products.length < MAX_PRODUCTS && page <= maxPages) {
    const endpoint = `${origin}/collections/${encodeURIComponent(handle)}/products.json?limit=250&page=${page}`;
    let data;
    try {
      data = await withRetry(`Shopify collection ${handle} p${page}`, () =>
        fetchJson(endpoint)
      );
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
    const batch = Array.isArray(data?.products) ? data.products : [];
    if (!batch.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
    page += 1;
    await sleep(250);
  }
  return products;
}

/**
 * Intelligent WooCommerce crawl — E-Liquids section only.
 * Stops if no E-Liquids category exists (no flat-catalog / shop-wide fallback).
 */
export async function scrapeWooCommerce(storeUrl) {
  const origin = originOf(storeUrl);
  console.log(`[scraper] WooCommerce E-Liquids-only crawl: ${origin}`);

  try {
    const products = await scrapeWooByCategories(origin);
    if (products.length) {
      console.log(`[scraper] WooCommerce E-Liquids category crawl: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] Woo E-Liquids category crawl failed: ${error.message}`);
  }

  // HTML — E-Liquids category paths only (never /shop or full catalog)
  const shopPaths = [
    `${origin}/product-category/e-liquids/`,
    `${origin}/product-category/e-liquid/`,
    `${origin}/product-category/e-juice/`,
    `${origin}/product-category/e-juices/`,
    `${origin}/product-category/vape-juice/`,
    `${origin}/product-category/vape-liquid/`,
  ];

  const seen = new Set();
  const products = [];
  const descriptionPool = new Map();

  for (const path of shopPaths) {
    try {
      const html = await fetchPageHtml(path);
      const parsed = parseProductsFromHtml(html, path, 'woocommerce');
      for (const p of parsed) {
        p.category = p.category || 'E-Liquids';
        if (!isLikelyELiquidProduct(p)) continue;
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        products.push(p);
      }
      await enrichHtmlProducts(products, descriptionPool, 25);
      if (products.length >= 30) break;
    } catch (error) {
      console.warn(`[scraper] Woo HTML path failed (${path}): ${error.message}`);
    }
  }

  console.log(`[scraper] WooCommerce HTML (E-Liquids): ${products.length} products from ${origin}`);
  return products;
}

/**
 * Walk only the E-Liquids category tree:
 * - If subcategories exist → process each subcategory (products + variants)
 * - If none → scrape products directly from the E-Liquids category
 */
async function scrapeWooByCategories(origin) {
  const categories = await fetchWooCategories(origin);
  if (!categories.length) return [];

  const byId = new Map(categories.map((c) => [c.id, c]));
  const childrenOf = (parentId) => categories.filter((c) => c.parent === parentId);

  const eLiquidRoots = categories.filter((c) => {
    if (!isELiquidCategoryName(c.name)) return false;
    // Prefer top-most E-Liquids nodes (skip if parent is also E-Liquids)
    const parent = c.parent ? byId.get(c.parent) : null;
    if (parent && isELiquidCategoryName(parent.name)) return false;
    return true;
  });

  if (!eLiquidRoots.length) {
    console.warn('[scraper] No E-Liquids category found on WooCommerce store');
    return [];
  }

  const products = [];
  const seen = new Set();
  const descriptionPool = new Map();
  const walkTargets = [];

  for (const root of eLiquidRoots) {
    const descendants = collectWooDescendants(root.id, childrenOf);
    const usableKids = descendants.filter(
      (kid) => !isExcludedNonELiquidCategory(kid.name) || isELiquidCategoryName(kid.name)
    );

    if (usableKids.length) {
      for (const kid of usableKids) {
        const parent = kid.parent ? byId.get(kid.parent) : null;
        walkTargets.push({
          category: cleanText(root.name),
          subcategory: cleanText(kid.name),
          categoryId: kid.id,
          categoryDescription: cleanDescription(root.description),
          subcategoryDescription: cleanDescription(kid.description),
          parentName: parent?.name || root.name,
        });
      }
    } else {
      walkTargets.push({
        category: cleanText(root.name),
        subcategory: null,
        categoryId: root.id,
        categoryDescription: cleanDescription(root.description),
        subcategoryDescription: null,
      });
    }
  }

  console.log(
    `[scraper] Woo E-Liquids: ${eLiquidRoots.length} root(s), ${walkTargets.length} scrape target(s)`
  );

  for (const target of walkTargets) {
    if (products.length >= MAX_PRODUCTS) break;
    let batch = [];
    try {
      batch = await fetchWooStoreProductsByCategory(origin, target.categoryId);
      console.log(
        `[scraper] Woo "${target.category}"${
          target.subcategory ? ` → ${target.subcategory}` : ''
        }: ${batch.length} parent products`
      );
    } catch (error) {
      console.warn(
        `[scraper] Woo subcategory failed (${target.category}${
          target.subcategory ? ` → ${target.subcategory}` : ''
        }): ${error.message}`
      );
      continue;
    }

    for (const item of batch) {
      if (item.is_purchasable === false && item.is_in_stock === false) continue;

      // Hydrate variations for variable products
      let hydrated = item;
      if (item.type === 'variable' || (Array.isArray(item.variations) && item.variations.length)) {
        try {
          hydrated = await hydrateWooProduct(origin, item);
        } catch (error) {
          console.warn(`[scraper] Woo hydrate ${item.id} failed: ${error.message}`);
        }
      }

      const exploded = explodeWooProduct(hydrated, origin, target, descriptionPool);
      for (const row of exploded) {
        if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
        // Enforce E-Liquids restriction even if a miscategorized item appears
        if (!isLikelyELiquidProduct(row) && !isELiquidCategoryName(target.category)) continue;
        seen.add(row.externalId);
        products.push(row);
      }
    }
  }

  return products;
}

/** Depth-first list of all descendant categories under a Woo parent. */
function collectWooDescendants(parentId, childrenOf, acc = []) {
  for (const child of childrenOf(parentId)) {
    acc.push(child);
    collectWooDescendants(child.id, childrenOf, acc);
  }
  return acc;
}

async function fetchWooCategories(origin) {
  const categories = [];
  let page = 1;
  while (page <= 20) {
    const endpoint = `${origin}/wp-json/wc/store/v1/products/categories?per_page=100&page=${page}`;
    let batch;
    try {
      batch = await withRetry(`Woo categories page ${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
    if (!Array.isArray(batch) || !batch.length) break;
    for (const cat of batch) {
      if (!cat?.id || !cat?.name) continue;
      if (/uncategorized/i.test(cat.name)) continue;
      categories.push({
        id: cat.id,
        name: cleanText(cat.name),
        parent: cat.parent || 0,
        description: cat.description || '',
        count: cat.count,
      });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return categories;
}

async function fetchWooStoreProductsByCategory(origin, categoryId) {
  const products = [];
  let page = 1;
  while (products.length < MAX_PRODUCTS) {
    const endpoint = `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}&category=${categoryId}`;
    let batch;
    try {
      batch = await withRetry(`Woo category ${categoryId} p${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
    if (!Array.isArray(batch) || !batch.length) break;
    products.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return products;
}

async function hydrateWooProduct(origin, item) {
  try {
    const detail = await withRetry(`Woo product ${item.id}`, () =>
      fetchJson(`${origin}/wp-json/wc/store/v1/products/${item.id}`)
    );
    if (detail && typeof detail === 'object') {
      // Fetch variation children when IDs are listed
      if (Array.isArray(detail.variations) && detail.variations.length && typeof detail.variations[0] === 'number') {
        const variations = [];
        for (const variationId of detail.variations.slice(0, 50)) {
          try {
            const variation = await fetchJson(
              `${origin}/wp-json/wc/store/v1/products/${variationId}`
            );
            if (variation) variations.push(variation);
          } catch {
            // skip missing variation
          }
        }
        detail.variations = variations;
      }
      return detail;
    }
  } catch {
    // fall through
  }
  return item;
}

async function scrapeWooStoreApi(origin) {
  const products = [];
  const seen = new Set();
  const descriptionPool = new Map();
  let page = 1;

  while (products.length < MAX_PRODUCTS) {
    const endpoint = `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    let batch;
    try {
      batch = await withRetry(`Woo Store API page ${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      break;
    }

    if (!Array.isArray(batch) || !batch.length) break;

    for (const item of batch) {
      if (item.is_purchasable === false && item.is_in_stock === false) continue;
      if (!wooItemBelongsToELiquid(item)) continue;

      let hydrated = item;
      if (item.type === 'variable') {
        try {
          hydrated = await hydrateWooProduct(origin, item);
        } catch {
          hydrated = item;
        }
      }

      const taxonomy = wooELiquidTaxonomyFromItem(item);
      const exploded = explodeWooProduct(hydrated, origin, taxonomy, descriptionPool);
      for (const row of exploded) {
        if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
        if (!isLikelyELiquidProduct(row)) continue;
        seen.add(row.externalId);
        products.push(row);
      }
    }

    if (batch.length < 100) break;
    page += 1;
  }

  return products;
}

function wooItemBelongsToELiquid(item) {
  const cats = Array.isArray(item.categories) ? item.categories : [];
  const catNames = cats.map((c) => c.name || c.label || '').filter(Boolean);
  if (catNames.some(isELiquidCategoryName)) return true;
  if (catNames.some(isExcludedNonELiquidCategory) && !catNames.some(isELiquidCategoryName)) {
    return false;
  }
  const title = item.name || item.title?.rendered || item.title || '';
  const desc = item.description || item.short_description || '';
  return BOTTLE_HINT_RE_LOCAL.test(`${title} ${desc}`);
}

function wooELiquidTaxonomyFromItem(item) {
  const cats = Array.isArray(item.categories) ? item.categories : [];
  const names = cats.map((c) => c.name || c.label || '').filter(Boolean);
  const eRoot = names.find(isELiquidCategoryName) || 'E-Liquids';
  const sub =
    names.find((n) => n !== eRoot && !isExcludedNonELiquidCategory(n)) ||
    names.find((n) => n !== eRoot) ||
    null;
  return {
    category: cleanText(eRoot),
    subcategory: sub && !isELiquidCategoryName(sub) ? cleanText(sub) : null,
  };
}

async function scrapeWpProducts(origin) {
  const products = [];
  const seen = new Set();
  const descriptionPool = new Map();
  let page = 1;

  while (products.length < MAX_PRODUCTS) {
    const endpoint = `${origin}/wp-json/wp/v2/product?per_page=100&page=${page}`;
    let batch;
    try {
      batch = await withRetry(`WP product page ${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      break;
    }

    if (!Array.isArray(batch) || !batch.length) break;

    for (const item of batch) {
      const title = item.title?.rendered || item.title || '';
      const content = item.content?.rendered || item.excerpt?.rendered || '';
      if (!BOTTLE_HINT_RE_LOCAL.test(`${title} ${content}`) && !isELiquidCategoryName(title)) {
        continue;
      }

      const exploded = explodeWooProduct(
        {
          id: item.id,
          name: title,
          link: item.link,
          description: content,
        },
        origin,
        { category: 'E-Liquids', subcategory: null },
        descriptionPool
      );
      for (const row of exploded) {
        if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
        if (!isLikelyELiquidProduct(row)) continue;
        seen.add(row.externalId);
        products.push(row);
      }
    }

    if (batch.length < 100) break;
    page += 1;
  }

  return products;
}

/**
 * Generic HTML product extraction (links, headings, JSON-LD).
 * Variants and rich fields are filled when PDP enrichment runs afterward.
 */
export function parseProductsFromHtml(html, pageUrl, platform = 'generic') {
  if (!html) return [];

  const products = [];
  const seen = new Set();

  const linkPattern =
    /<a\b[^>]*href=["']([^"']*(?:product|products|collections|shop)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    const title = cleanText(stripTags(match[2]));
    if (!title || title.length < 3 || title.length > 200) continue;
    if (/^(home|shop|cart|login|account|search|menu|sale|new)$/i.test(title)) continue;

    const absoluteUrl = toAbsoluteUrl(href, pageUrl);
    const externalId = `html:${(absoluteUrl || title).toLowerCase().slice(0, 180)}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    products.push(
      buildRichProduct(title, absoluteUrl, { externalId, platform })
    );
  }

  if (products.length < 3) {
    const headingPattern = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
    while ((match = headingPattern.exec(html)) !== null) {
      const title = cleanText(stripTags(match[1]));
      if (!title || title.length < 4 || title.length > 160) continue;
      if (/^(products?|shop|collections?|home|about|contact)$/i.test(title)) continue;

      const externalId = `html:${title.toLowerCase().slice(0, 180)}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      products.push(buildRichProduct(title, null, { externalId, platform }));
    }
  }

  const jsonLdPattern =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        for (const item of flattenJsonLdProducts(node)) {
          const title = cleanText(item.name || '');
          if (!title) continue;
          const externalId = `jsonld:${(item.url || title).toLowerCase().slice(0, 180)}`;
          if (seen.has(externalId)) continue;
          seen.add(externalId);

          let imageUrl = null;
          if (typeof item.image === 'string') imageUrl = item.image;
          else if (Array.isArray(item.image)) imageUrl = item.image[0]?.url || item.image[0];
          else if (item.image?.url) imageUrl = item.image.url;

          products.push(
            buildRichProduct(title, item.url || null, {
              brand: item.brand?.name || item.brand || null,
              externalId,
              platform,
              description: cleanDescription(item.description || ''),
              imageUrl,
              price: item.offers?.price != null ? Number(item.offers.price) : null,
            })
          );
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }

  return products.slice(0, MAX_PRODUCTS);
}

/**
 * Fetch individual product pages to collect descriptions / images (generic HTML path).
 */
async function enrichHtmlProducts(products, descriptionPool, limit = 40) {
  const { resolveSharedDescription } = await import('../utils/descriptionOptimize.js');
  let enriched = 0;
  for (const product of products) {
    if (enriched >= limit) break;
    if (!product.productUrl || product.description) continue;
    try {
      const html = await fetchPageHtml(product.productUrl);
      const descMatch = html.match(
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
      ) || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      const imgMatch = html.match(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
      );
      const bodyMatch = html.match(
        /<(?:div|section)[^>]*(?:product-description|description|product__description)[^>]*>([\s\S]*?)<\/(?:div|section)>/i
      );
      const rawDesc =
        cleanDescription(bodyMatch?.[1] || '') ||
        cleanDescription(descMatch?.[1] || '');
      const desc = resolveSharedDescription(rawDesc, null, null, descriptionPool);
      if (desc.description) {
        product.description = desc.description;
        product.descriptionHash = desc.descriptionHash;
        product.descriptionSource = desc.descriptionSource;
      }
      if (!product.imageUrl && imgMatch?.[1]) {
        product.imageUrl = imgMatch[1];
      }
      enriched += 1;
    } catch (error) {
      console.warn(`[scraper] PDP enrich failed (${product.productUrl}): ${error.message}`);
    }
  }
}

function flattenJsonLdProducts(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;

  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('Product')) acc.push(node);

  if (Array.isArray(node['@graph'])) {
    for (const child of node['@graph']) flattenJsonLdProducts(child, acc);
  }
  if (Array.isArray(node.itemListElement)) {
    for (const child of node.itemListElement) {
      flattenJsonLdProducts(child.item || child, acc);
    }
  }

  return acc;
}

/** @deprecated — use buildRichProduct from scraper.catalog.js */
function buildProduct(title, productUrl, extras = {}) {
  return buildRichProduct(title, productUrl, extras);
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
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

function toAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Full store crawl: detect platform, scrape E-Liquids products only.
 * Never crawls Devices, Tobacco, Cigars, Disposables, Pods, CBD, Snacks, etc.
 * If no E-Liquids category exists, raises a clear error and stops.
 */
export async function scrapeStoreProducts(storeWebsiteUrl) {
  const url = normalizeStoreUrl(storeWebsiteUrl);
  console.log(`[scraper] Starting E-Liquids inventory crawl for ${url}`);

  // 1) Shopify — E-Liquids collections only
  try {
    const shopifyProducts = await scrapeShopify(url);
    if (shopifyProducts.length > 0) {
      return finalizeELiquidProducts(shopifyProducts, url, 'shopify');
    }
    // Collections loaded but none are E-Liquids → stop (do not crawl other sections)
    const origin = originOf(url);
    try {
      const collections = await fetchShopifyCollections(origin, 5);
      if (
        collections.length &&
        !collections.some((c) => isELiquidCategoryName(c.title || c.handle))
      ) {
        throw new ApiError(
          422,
          'No E-Liquids category found on this store. The scraper only collects E-Liquids / E-Juice / Vape Juice products. Add a public E-Liquids collection and try again.'
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.warn(`[scraper] Shopify probe failed: ${error.message}`);
  }

  // 2) WooCommerce — E-Liquids category tree only
  try {
    const wooProducts = await scrapeWooCommerceApisOnly(url);
    if (wooProducts.length > 0) {
      return finalizeELiquidProducts(wooProducts, url, 'woocommerce');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.warn(`[scraper] WooCommerce API probe failed: ${error.message}`);
  }

  // 3) HTML — E-Liquids paths only (never full shop / all products)
  let platform = 'generic';
  let homepageHtml = '';

  try {
    homepageHtml = await fetchPageHtml(url);
    platform = detectPlatform(homepageHtml, url);
    console.log(`[scraper] Detected platform from HTML: ${platform}`);
  } catch (error) {
    console.warn(`[scraper] Homepage fetch failed: ${error.message}`);
  }

  if (platform === 'woocommerce' || platform === 'generic') {
    try {
      const wooProducts = await scrapeWooCommerce(url);
      if (wooProducts.length > 0) {
        return finalizeELiquidProducts(wooProducts, url, 'woocommerce');
      }
    } catch (error) {
      console.warn(`[scraper] WooCommerce HTML scrape failed: ${error.message}`);
    }
  }

  const eLiquidPaths = discoverELiquidPathsFromHtml(homepageHtml, url);
  const origin = originOf(url);
  const eLiquidOnlyPaths = [
    ...eLiquidPaths,
    `${origin}/collections/e-liquids`,
    `${origin}/collections/e-liquid`,
    `${origin}/collections/e-juice`,
    `${origin}/collections/e-liquid-juice`,
    `${origin}/collections/vape-juice`,
    `${origin}/product-category/e-liquids/`,
    `${origin}/product-category/e-liquid/`,
  ];

  if (!eLiquidPaths.length && !homepageHtml) {
    throw new ApiError(
      422,
      'No E-Liquids category found on this store. The scraper only collects E-Liquids / E-Juice / Vape Juice products.'
    );
  }

  const htmlProducts = [];
  const seen = new Set();

  for (const path of eLiquidOnlyPaths) {
    if (htmlProducts.length >= 40) break;
    try {
      const html = await fetchPageHtml(path);
      const parsed = parseProductsFromHtml(html, path, detectPlatform(html, path));
      for (const p of parsed) {
        p.category = p.category || 'E-Liquids';
        if (!isLikelyELiquidProduct(p) || seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        htmlProducts.push(p);
      }
    } catch (error) {
      console.warn(`[scraper] E-Liquids path failed (${path}): ${error.message}`);
    }
  }

  if (htmlProducts.length) {
    await enrichHtmlProducts(htmlProducts, new Map(), 40);
    return finalizeELiquidProducts(htmlProducts, url, platform);
  }

  throw new ApiError(
    422,
    'No E-Liquids category found on this store. The scraper only collects E-Liquids / E-Juice / Vape Juice products. Unrelated categories (Devices, Tobacco, Cigars, Disposables, Pods, CBD, etc.) are never scraped.'
  );
}

/** Collect likely E-Liquids category URLs from homepage markup. */
function discoverELiquidPathsFromHtml(html, baseUrl) {
  if (!html) return [];
  const paths = [];
  const seen = new Set();
  const linkRe = /href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const label = cleanText(stripTags(match[2]));
    if (!isELiquidCategoryName(`${href} ${label}`)) continue;
    if (isExcludedNonELiquidCategory(label)) continue;
    const absolute = toAbsoluteUrl(href, baseUrl);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    paths.push(absolute);
  }
  return paths.slice(0, 12);
}

function finalizeELiquidProducts(products, url, platform) {
  const filtered = dedupeProducts(products).filter(isLikelyELiquidProduct);
  console.log(
    `[scraper] Crawl complete: ${filtered.length} E-Liquid products from ${url} (${platform})`
  );

  if (!filtered.length) {
    throw new ApiError(
      422,
      'No E-Liquids products found at this URL. Confirm the store has a public E-Liquids / E-Juice category and try again.'
    );
  }

  return filtered;
}

/** WooCommerce JSON APIs — E-Liquids category tree only (no flat catalog crawl). */
async function scrapeWooCommerceApisOnly(storeUrl) {
  const origin = originOf(storeUrl);

  try {
    const products = await scrapeWooByCategories(origin);
    if (products.length) {
      console.log(`[scraper] WooCommerce E-Liquids category crawl: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] Woo E-Liquids category crawl failed: ${error.message}`);
  }

  return [];
}

function dedupeProducts(products) {
  const map = new Map();
  for (const product of products) {
    const key = product.externalId || product.name.toLowerCase();
    if (!map.has(key)) map.set(key, product);
  }
  return [...map.values()].slice(0, MAX_PRODUCTS);
}
