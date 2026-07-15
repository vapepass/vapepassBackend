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
 * Intelligent Shopify crawl:
 * 1) products.json first (variants exploded) — avoids 429 from collection fan-out
 * 2) optional collections pass for richer category labels when rate limit allows
 */
export async function scrapeShopify(storeUrl) {
  const origin = originOf(storeUrl);
  const products = [];
  const seen = new Set();
  const descriptionPool = new Map();

  console.log(`[scraper] Shopify intelligent crawl: ${origin}`);

  // PRIMARY — full catalog via products.json (one endpoint, paginated)
  let page = 1;
  while (products.length < MAX_PRODUCTS) {
    const endpoint = `${origin}/products.json?limit=250&page=${page}`;
    let data;
    try {
      data = await withRetry(`Shopify products page ${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      console.warn(`[scraper] Shopify products pagination stopped: ${error.message}`);
      break;
    }

    const batch = Array.isArray(data?.products) ? data.products : [];
    if (!batch.length) break;

    for (const item of batch) {
      if (item.status && item.status !== 'active') continue;
      const subcategory =
        item.tags
          ? String(item.tags)
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)[0]
          : null;
      const exploded = explodeShopifyProduct(
        item,
        origin,
        {
          category: item.product_type || null,
          subcategory:
            subcategory && subcategory !== item.product_type ? subcategory : null,
          categoryDescription: null,
        },
        descriptionPool
      );
      for (const row of exploded) {
        if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
        seen.add(row.externalId);
        products.push(row);
      }
    }

    console.log(
      `[scraper] Shopify products.json page ${page}: +${batch.length} parents → ${products.length} variants total`
    );

    if (batch.length < 250) break;
    page += 1;
    await sleep(400);
  }

  // OPTIONAL — enrich category / subcategory from collections (best-effort, paced)
  if (products.length > 0) {
    try {
      await sleep(600);
      const collections = await fetchShopifyCollections(origin, 40);
      if (collections.length) {
        console.log(
          `[scraper] Shopify: enriching categories from up to ${collections.length} collections`
        );
        let enriched = 0;
        for (const collection of collections) {
          if (enriched >= 25) break;
          try {
            await sleep(300);
            const collectionProducts = await fetchShopifyCollectionProducts(
              origin,
              collection.handle,
              2
            );
            const category = cleanText(collection.title || collection.handle || 'Collection');
            const categoryDescription = cleanDescription(collection.body_html || '');
            const handleSet = new Set(
              collectionProducts.map((p) => p.handle || String(p.id)).filter(Boolean)
            );
            for (const row of products) {
              const parentHandle = row.parentExternalId?.replace(/^shopify:/, '');
              if (!parentHandle || !handleSet.has(parentHandle)) continue;

              // Prefer collection title as category; keep product_type as subcategory when different
              if (!row.category || row.category === row.subcategory) {
                if (row.category && row.category !== category && !row.subcategory) {
                  row.subcategory = row.category;
                }
                row.category = category;
              } else if (!row.subcategory && category !== row.category) {
                row.subcategory = category;
              }

              if (categoryDescription && !row.description) {
                row.description = categoryDescription;
                row.descriptionSource = row.descriptionSource || 'category';
              }
            }
            enriched += 1;
          } catch (error) {
            console.warn(
              `[scraper] Shopify collection enrich skipped (${collection.handle}): ${error.message}`
            );
            break;
          }
        }
      }
    } catch (error) {
      console.warn(`[scraper] Shopify collection enrichment skipped: ${error.message}`);
    }
  }

  console.log(
    `[scraper] Shopify: ${products.length} variant-level products from ${origin}`
  );
  return products;
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
 * Intelligent WooCommerce crawl:
 * categories → subcategories → products → variants as independent products.
 */
export async function scrapeWooCommerce(storeUrl) {
  const origin = originOf(storeUrl);
  console.log(`[scraper] WooCommerce intelligent crawl: ${origin}`);

  try {
    const products = await scrapeWooByCategories(origin);
    if (products.length) {
      console.log(`[scraper] WooCommerce category crawl: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] Woo category crawl failed: ${error.message}`);
  }

  // 1) WooCommerce Store API (often public, no auth)
  try {
    const products = await scrapeWooStoreApi(origin);
    if (products.length) {
      console.log(`[scraper] WooCommerce Store API: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] Woo Store API failed: ${error.message}`);
  }

  // 2) WordPress product post type
  try {
    const products = await scrapeWpProducts(origin);
    if (products.length) {
      console.log(`[scraper] WP products API: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] WP products API failed: ${error.message}`);
  }

  // 3) HTML shop / category pages via ScrapingBee
  const shopPaths = [
    storeUrl,
    `${origin}/shop/`,
    `${origin}/shop`,
    `${origin}/products/`,
    `${origin}/product-category/`,
  ];

  const seen = new Set();
  const products = [];
  const descriptionPool = new Map();

  for (const path of shopPaths) {
    try {
      const html = await fetchPageHtml(path);
      const parsed = parseProductsFromHtml(html, path, 'woocommerce');
      for (const p of parsed) {
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        products.push(p);
      }
      // Enrich a sample of product pages for descriptions/images
      await enrichHtmlProducts(products, descriptionPool, 25);
      if (products.length >= 30) break;
    } catch (error) {
      console.warn(`[scraper] Woo HTML path failed (${path}): ${error.message}`);
    }
  }

  console.log(`[scraper] WooCommerce HTML: ${products.length} products from ${origin}`);
  return products;
}

async function scrapeWooByCategories(origin) {
  const categories = await fetchWooCategories(origin);
  if (!categories.length) return [];

  const byId = new Map(categories.map((c) => [c.id, c]));
  const roots = categories.filter((c) => !c.parent);
  const childrenOf = (parentId) => categories.filter((c) => c.parent === parentId);

  const products = [];
  const seen = new Set();
  const descriptionPool = new Map();

  // Categories with children → CASE 1 (subcategories)
  // Leaf categories without children → CASE 2 (products directly)
  const walkTargets = [];

  for (const root of roots.length ? roots : categories) {
    const kids = childrenOf(root.id);
    if (kids.length) {
      for (const kid of kids) {
        walkTargets.push({
          category: root.name,
          subcategory: kid.name,
          categoryId: kid.id,
          categoryDescription: cleanDescription(root.description),
          subcategoryDescription: cleanDescription(kid.description),
        });
      }
    } else {
      walkTargets.push({
        category: root.name,
        subcategory: null,
        categoryId: root.id,
        categoryDescription: cleanDescription(root.description),
        subcategoryDescription: null,
      });
    }
  }

  // Also include orphan subcategories
  for (const cat of categories) {
    if (!cat.parent) continue;
    const parent = byId.get(cat.parent);
    if (!parent) {
      walkTargets.push({
        category: cat.name,
        subcategory: null,
        categoryId: cat.id,
        categoryDescription: cleanDescription(cat.description),
        subcategoryDescription: null,
      });
    }
  }

  for (const target of walkTargets) {
    if (products.length >= MAX_PRODUCTS) break;
    const batch = await fetchWooStoreProductsByCategory(origin, target.categoryId);
    console.log(
      `[scraper] Woo "${target.category}"${target.subcategory ? ` → ${target.subcategory}` : ''}: ${batch.length} parent products`
    );

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
        seen.add(row.externalId);
        products.push(row);
      }
    }
  }

  return products;
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
      let hydrated = item;
      if (item.type === 'variable') {
        try {
          hydrated = await hydrateWooProduct(origin, item);
        } catch {
          hydrated = item;
        }
      }
      const exploded = explodeWooProduct(
        hydrated,
        origin,
        {
          category: item.categories?.[0]?.name || null,
          subcategory: item.categories?.[1]?.name || null,
        },
        descriptionPool
      );
      for (const row of exploded) {
        if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
        seen.add(row.externalId);
        products.push(row);
      }
    }

    if (batch.length < 100) break;
    page += 1;
  }

  return products;
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
      const exploded = explodeWooProduct(
        {
          id: item.id,
          name: item.title?.rendered || item.title,
          link: item.link,
          description: item.content?.rendered || item.excerpt?.rendered || '',
        },
        origin,
        {},
        descriptionPool
      );
      for (const row of exploded) {
        if (seen.has(row.externalId) || products.length >= MAX_PRODUCTS) continue;
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
 * Full store crawl: detect platform, scrape all active products.
 * Accepts store homepage or products page URL.
 * Prefers platform JSON APIs (fast, reliable) before HTML scraping.
 */
export async function scrapeStoreProducts(storeWebsiteUrl) {
  const url = normalizeStoreUrl(storeWebsiteUrl);
  console.log(`[scraper] Starting inventory crawl for ${url}`);

  // 1) Shopify public products.json (Hootz and most Shopify stores)
  try {
    const shopifyProducts = await scrapeShopify(url);
    if (shopifyProducts.length > 0) {
      return dedupeProducts(shopifyProducts);
    }
  } catch (error) {
    console.warn(`[scraper] Shopify probe failed: ${error.message}`);
  }

  // 2) WooCommerce / WordPress product APIs (The Vape Father and WP shops)
  try {
    const wooProducts = await scrapeWooCommerceApisOnly(url);
    if (wooProducts.length > 0) {
      return dedupeProducts(wooProducts);
    }
  } catch (error) {
    console.warn(`[scraper] WooCommerce API probe failed: ${error.message}`);
  }

  // 3) HTML crawl via ScrapingBee / Playwright
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
      if (wooProducts.length > 0) return dedupeProducts(wooProducts);
    } catch (error) {
      console.warn(`[scraper] WooCommerce HTML scrape failed: ${error.message}`);
    }
  }

  const htmlProducts = homepageHtml
    ? parseProductsFromHtml(homepageHtml, url, platform)
    : [];

  if (!htmlProducts.length) {
    const origin = originOf(url);
    for (const path of [`${origin}/shop/`, `${origin}/products`, `${origin}/collections/all`]) {
      try {
        const html = await fetchPageHtml(path);
        const parsed = parseProductsFromHtml(html, path, detectPlatform(html, path));
        htmlProducts.push(...parsed);
        if (htmlProducts.length >= 10) break;
      } catch (error) {
        console.warn(`[scraper] Fallback path failed (${path}): ${error.message}`);
      }
    }
  }

  if (htmlProducts.length) {
    await enrichHtmlProducts(htmlProducts, new Map(), 40);
  }

  const products = dedupeProducts(htmlProducts);
  console.log(`[scraper] Crawl complete: ${products.length} products from ${url} (${platform})`);

  if (!products.length) {
    throw new ApiError(
      422,
      'No products found at this URL. Confirm the store website is publicly accessible and try again.'
    );
  }

  return products;
}

/** WooCommerce JSON APIs — prefer category → subcategory crawl, then flat catalog. */
async function scrapeWooCommerceApisOnly(storeUrl) {
  const origin = originOf(storeUrl);

  // CASE 1 / 2 — intelligent category hierarchy first
  try {
    const products = await scrapeWooByCategories(origin);
    if (products.length) {
      console.log(`[scraper] WooCommerce category crawl: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] Woo category crawl failed: ${error.message}`);
  }

  try {
    const products = await scrapeWooStoreApi(origin);
    if (products.length) {
      console.log(`[scraper] WooCommerce Store API: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] Woo Store API failed: ${error.message}`);
  }

  try {
    const products = await scrapeWpProducts(origin);
    if (products.length) {
      console.log(`[scraper] WP products API: ${products.length} products`);
      return products;
    }
  } catch (error) {
    console.warn(`[scraper] WP products API failed: ${error.message}`);
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
