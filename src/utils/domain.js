/**
 * Domain / hostname helpers for embed script authorization.
 */

/**
 * Extract hostname from a URL or host-like string.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function extractHostname(value) {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

/**
 * Normalize hostname for comparison (lowercase, strip www.).
 * @param {string|null|undefined} hostname
 * @returns {string|null}
 */
export function normalizeHostname(hostname) {
  if (!hostname) return null;
  return String(hostname)
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * True for local development hosts (Live Server, Next.js, etc.).
 * @param {string|null|undefined} host
 * @returns {boolean}
 */
export function isLocalDevHost(host) {
  if (!host) return false;
  const h = normalizeHostname(host);
  return h === 'localhost' || h === '127.0.0.1' || Boolean(h && h.endsWith('.localhost'));
}

/**
 * Resolve the allowed hostname for a store from its website / product URL.
 * @param {{ productPageUrl?: string|null, websiteUrl?: string|null, allowedHostname?: string|null }} store
 * @returns {string|null}
 */
export function getStoreAllowedHostname(store) {
  if (!store) return null;
  if (store.allowedHostname) return normalizeHostname(store.allowedHostname);
  return extractHostname(store.websiteUrl || store.productPageUrl);
}

/**
 * Check whether a request Origin/Referer matches the store's allowed website.
 * Localhost is only allowed when options.allowLocalhost is true (non-production),
 * OR when the store's authorized domain itself is a local host.
 * Optional extraHosts (e.g. marketing site) may also be allowed for demos.
 * @param {string|null|undefined} originOrReferer
 * @param {object} store
 * @param {{ allowLocalhost?: boolean, extraHosts?: string[] }} [options]
 * @returns {boolean}
 */
export function isOriginAllowedForStore(originOrReferer, store, options = {}) {
  const allowed = getStoreAllowedHostname(store);
  const requestHost = extractHostname(originOrReferer);
  if (!requestHost) return false;

  // Match the store's single active authorized hostname first
  if (allowed && requestHost === allowed) {
    return true;
  }

  if (options.allowLocalhost !== false && isLocalDevHost(requestHost)) {
    return true;
  }

  const extras = (options.extraHosts || [])
    .map((host) => normalizeHostname(host) || extractHostname(host))
    .filter(Boolean);
  if (extras.includes(requestHost)) return true;

  return false;
}

/**
 * True when the request Origin is the VapePass marketing/client app (iframe host).
 * @param {string|null|undefined} origin
 * @param {string|null|undefined} clientUrl
 * @returns {boolean}
 */
export function isClientAppOrigin(origin, clientUrl) {
  const requestHost = extractHostname(origin);
  const clientHost = extractHostname(clientUrl);
  if (!requestHost || !clientHost) return false;
  return normalizeHostname(requestHost) === normalizeHostname(clientHost);
}

/**
 * Pick the best available origin signal from an Express request.
 * When the chat UI is loaded in an iframe on CLIENT_URL, prefer
 * X-Vapepass-Parent-Origin (the merchant page) for domain checks.
 * @param {import('express').Request} req
 * @param {{ clientUrl?: string }} [options]
 * @returns {string|null}
 */
export function getRequestOrigin(req, options = {}) {
  const origin = req.get('origin');
  const parentOrigin = req.get('x-vapepass-parent-origin');
  const clientUrl = options.clientUrl;

  // Embed iframe: browser Origin is CLIENT_URL; merchant site is in the custom header.
  if (parentOrigin && clientUrl && isClientAppOrigin(origin, clientUrl)) {
    return parentOrigin;
  }

  if (origin) return origin;

  const referer = req.get('referer') || req.get('referrer');
  if (referer) return referer;

  return null;
}
