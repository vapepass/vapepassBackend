import dns from 'dns';
import https from 'https';
import http from 'http';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';

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
const POD_HINT_RE = /\b(pod|cartridge|pre[- ]?filled|disposable)\b/i;
const BOTTLE_HINT_RE = /\b(e[- ]?liquid|e[- ]?juice|refill|bottle|salt\s*nic)\b/i;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1200;
const MAX_PRODUCTS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with exponential backoff retries.
 */
async function withRetry(label, fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const status = error.status || error.statusCode;
      // Do not retry permanent client errors (404/401/403)
      const clientError = status && status >= 400 && status < 500 && status !== 429;
      // Do not retry hard connect failures — host is unreachable from this network
      const connectError = /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|Connect Timeout/i.test(
        error.message || ''
      );
      console.warn(
        `[scraper] ${label} attempt ${attempt}/${retries} failed: ${error.message}`
      );
      if (clientError || connectError || attempt >= retries) break;
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
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
 * Fetch HTML via ScrapingBee (preferred) or Playwright.
 */
export async function fetchPageHtml(url) {
  const normalized = normalizeStoreUrl(url);

  if (env.scrapingBee.apiKey) {
    try {
      return await withRetry('ScrapingBee', () => fetchWithScrapingBee(normalized));
    } catch (error) {
      console.error('[scraper] ScrapingBee exhausted retries, trying Playwright:', error.message);
    }
  }

  return withRetry('Playwright', () => fetchWithPlaywright(normalized));
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
    throw new Error(`ScrapingBee HTTP ${response.status}: ${body.slice(0, 200)}`);
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
 */
async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (compatible; VapePassInventoryBot/1.0; +https://vapepass.app)',
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
 * Scrape Shopify catalog via public /products.json (paginated).
 */
export async function scrapeShopify(storeUrl) {
  const origin = originOf(storeUrl);
  const products = [];
  let page = 1;

  console.log(`[scraper] Shopify catalog scrape: ${origin}`);

  while (products.length < MAX_PRODUCTS) {
    const endpoint = `${origin}/products.json?limit=250&page=${page}`;
    let data;
    try {
      data = await withRetry(`Shopify page ${page}`, () => fetchJson(endpoint));
    } catch (error) {
      if (page === 1) throw error;
      break;
    }

    const batch = Array.isArray(data?.products) ? data.products : [];
    if (!batch.length) break;

    for (const item of batch) {
      if (item.status && item.status !== 'active') continue;
      const title = cleanText(item.title || '');
      if (!title) continue;

      const handle = item.handle || String(item.id);
      const productUrl = `${origin}/products/${handle}`;
      const variantText = (item.variants || [])
        .map((v) => v.title)
        .filter(Boolean)
        .join(' ');
      const combined = `${title} ${variantText} ${item.product_type || ''} ${item.vendor || ''}`;

      products.push(
        buildProduct(title, productUrl, {
          brand: item.vendor || null,
          externalId: `shopify:${handle}`,
          platform: 'shopify',
          textForSpecs: combined,
        })
      );
    }

    if (batch.length < 250) break;
    page += 1;
  }

  console.log(`[scraper] Shopify: ${products.length} products from ${origin}`);
  return products;
}

/**
 * Scrape WooCommerce via Store API, then REST, then HTML shop pages.
 */
export async function scrapeWooCommerce(storeUrl) {
  const origin = originOf(storeUrl);
  console.log(`[scraper] WooCommerce catalog scrape: ${origin}`);

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
    `${origin}/product-category/disposables/`,
  ];

  const seen = new Set();
  const products = [];

  for (const path of shopPaths) {
    try {
      const html = await fetchPageHtml(path);
      const parsed = parseProductsFromHtml(html, path, 'woocommerce');
      for (const p of parsed) {
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        products.push(p);
      }
      if (products.length >= 20) break;
    } catch (error) {
      console.warn(`[scraper] Woo HTML path failed (${path}): ${error.message}`);
    }
  }

  console.log(`[scraper] WooCommerce HTML: ${products.length} products from ${origin}`);
  return products;
}

async function scrapeWooStoreApi(origin) {
  const products = [];
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
      const title = cleanText(item.name || '');
      if (!title) continue;

      const id = item.id != null ? String(item.id) : title.toLowerCase();
      const productUrl = item.permalink || `${origin}/?p=${id}`;

      products.push(
        buildProduct(title, productUrl, {
          brand: item.brands?.[0]?.name || null,
          externalId: `woo:${id}`,
          platform: 'woocommerce',
          textForSpecs: `${title} ${item.short_description || ''} ${item.description || ''}`,
        })
      );
    }

    if (batch.length < 100) break;
    page += 1;
  }

  return products;
}

async function scrapeWpProducts(origin) {
  const products = [];
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
      const title = cleanText(item.title?.rendered || item.title || '');
      if (!title) continue;
      const id = item.id != null ? String(item.id) : title.toLowerCase();
      const productUrl = item.link || `${origin}/?p=${id}`;

      products.push(
        buildProduct(title, productUrl, {
          externalId: `woo:${id}`,
          platform: 'woocommerce',
        })
      );
    }

    if (batch.length < 100) break;
    page += 1;
  }

  return products;
}

/**
 * Generic HTML product extraction (links, headings, JSON-LD).
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
      buildProduct(title, absoluteUrl, { externalId, platform })
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
      products.push(buildProduct(title, null, { externalId, platform }));
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
          products.push(
            buildProduct(title, item.url || null, {
              brand: item.brand?.name || item.brand || null,
              externalId,
              platform,
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

function buildProduct(title, productUrl, extras = {}) {
  const textForSpecs = extras.textForSpecs || title;
  const nicotineMatch = textForSpecs.match(NICOTINE_RE);
  const volumeMatch = textForSpecs.match(VOLUME_RE);
  const nicotineMgMl = nicotineMatch ? Number(nicotineMatch[1]) : null;
  const volumeMl = volumeMatch ? Number(volumeMatch[1]) : null;

  let productType = 'other';
  if (POD_HINT_RE.test(textForSpecs)) {
    productType = volumeMl != null && volumeMl <= 2 ? 'pod' : 'prefilled';
  } else if (BOTTLE_HINT_RE.test(textForSpecs) || (volumeMl != null && volumeMl > 2)) {
    productType = 'e_liquid';
  }

  const { brand, flavor } = splitBrandFlavor(title, extras.brand);
  const platform = extras.platform || 'generic';
  const externalId =
    extras.externalId ||
    `gen:${(productUrl || title).toLowerCase().slice(0, 180)}`;

  return {
    name: title,
    brand,
    flavor,
    nicotineMgMl: Number.isFinite(nicotineMgMl) ? nicotineMgMl : null,
    volumeMl: Number.isFinite(volumeMl) ? volumeMl : null,
    productType,
    productUrl,
    externalId,
    platform,
  };
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

/** WooCommerce JSON APIs only (no HTML) — used as a fast probe. */
async function scrapeWooCommerceApisOnly(storeUrl) {
  const origin = originOf(storeUrl);

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
