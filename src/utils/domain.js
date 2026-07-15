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
 * Localhost / 127.0.0.1 are allowed in non-production for development embeds.
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

  if (options.allowLocalhost !== false) {
    const isLocal =
      requestHost === 'localhost' ||
      requestHost === '127.0.0.1' ||
      requestHost.endsWith('.localhost');
    if (isLocal) return true;
  }

  const extras = (options.extraHosts || [])
    .map((host) => normalizeHostname(host) || extractHostname(host))
    .filter(Boolean);
  if (extras.includes(requestHost)) return true;

  if (!allowed) return false;
  return requestHost === allowed;
}

/**
 * Pick the best available origin signal from an Express request.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function getRequestOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin;

  const referer = req.get('referer') || req.get('referrer');
  if (referer) return referer;

  return null;
}
