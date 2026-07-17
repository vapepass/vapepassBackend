import Store from '../models/Store.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import {
  extractHostname,
  getRequestOrigin,
  getStoreAllowedHostname,
  isOriginAllowedForStore,
  normalizeHostname,
} from '../utils/domain.js';
import { canServeChatbot, hasServiceableSubscription } from '../utils/subscriptionAccess.js';
import { asyncHandler } from './asyncHandler.js';

function isMarketingDemoOrigin(origin) {
  const host = extractHostname(origin);
  if (!host) return false;

  const clientHost = extractHostname(env.clientUrl);
  if (clientHost && normalizeHostname(host) === normalizeHostname(clientHost)) {
    return true;
  }

  // Extra marketing / preview hosts (comma-separated), e.g. projectclient-zeta.vercel.app
  const extra = [
    ...env.marketingDemoHosts,
    ...String(process.env.MARKETING_DEMO_HOSTS || '')
      .split(',')
      .map((h) => h.trim()),
  ]
    .map((h) => normalizeHostname(h) || extractHostname(h))
    .filter(Boolean);
  if (extra.includes(normalizeHostname(host))) {
    return true;
  }

  // Vercel preview deployments of the marketing site when CLIENT_URL host is also on Vercel
  if (
    clientHost &&
    clientHost.endsWith('.vercel.app') &&
    host.endsWith('.vercel.app')
  ) {
    return true;
  }

  // Local Next.js marketing/demo host during development
  if (env.nodeEnv !== 'production') {
    return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
  }

  return false;
}

/**
 * Validates store ID, subscription, and authorized website domain for public embed APIs.
 * Expects storeId in params, body, or query.
 */
export const requireValidEmbedAccess = asyncHandler(async (req, res, next) => {
  const storeId = req.params.storeId || req.body?.storeId || req.query?.storeId;

  if (!storeId) {
    throw new ApiError(400, 'Store ID is required');
  }

  const store = await Store.findById(storeId).select(
    'name brandColor assistantEnabled productPageUrl websiteUrl allowedHostname country province legalAge subscriptionStatus setupCompletedAt inventoryProductCount'
  );

  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  const origin = getRequestOrigin(req);
  const demoMode = isMarketingDemoOrigin(origin);
  const allowLocalhost = env.nodeEnv !== 'production';
  const originOptions = {
    allowLocalhost,
    extraHosts: [
      env.clientUrl,
      env.apiPublicUrl,
      ...(env.marketingDemoHosts || []),
    ].filter(Boolean),
  };

  if (!demoMode && !hasServiceableSubscription(store)) {
    throw new ApiError(402, 'This store subscription is inactive. Chatbot unavailable.', {
      code: 'SUBSCRIPTION_INACTIVE',
    });
  }

  // In production, Origin/Referer must match the store website (or marketing/demo host).
  if (env.nodeEnv === 'production') {
    if (!origin) {
      throw new ApiError(403, 'Unauthorized embed origin', { code: 'ORIGIN_REQUIRED' });
    }
    if (!demoMode && !isOriginAllowedForStore(origin, store, { ...originOptions, allowLocalhost: false })) {
      throw new ApiError(403, 'Embedding is not authorized for this website', {
        code: 'ORIGIN_NOT_ALLOWED',
        allowedHostname: getStoreAllowedHostname(store),
      });
    }
  } else if (origin && !demoMode && !isOriginAllowedForStore(origin, store, originOptions)) {
    throw new ApiError(403, 'Embedding is not authorized for this website', {
      code: 'ORIGIN_NOT_ALLOWED',
      allowedHostname: getStoreAllowedHostname(store),
    });
  }

  req.embedStore = store;
  req.embedDemoMode = demoMode;
  next();
});

/**
 * Soft check used by widget bootstrap — returns disabled config instead of hard errors
 * when subscription/setup is incomplete (still enforces domain when provided).
 */
export const loadEmbedStore = asyncHandler(async (req, res, next) => {
  const storeId = req.params.storeId || req.body?.storeId || req.query?.storeId;
  if (!storeId) {
    throw new ApiError(400, 'Store ID is required');
  }

  const store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  const origin = getRequestOrigin(req);
  const demoMode = isMarketingDemoOrigin(origin);
  const allowLocalhost = env.nodeEnv !== 'production';
  const originOptions = {
    allowLocalhost,
    extraHosts: [
      env.clientUrl,
      env.apiPublicUrl,
      ...(env.marketingDemoHosts || []),
    ].filter(Boolean),
  };

  if (origin && !demoMode) {
    const allowed = isOriginAllowedForStore(origin, store, originOptions);
    if (!allowed && getStoreAllowedHostname(store)) {
      req.embedDomainDenied = true;
    }
  } else if (!origin && env.nodeEnv === 'production' && getStoreAllowedHostname(store) && !demoMode) {
    req.embedDomainDenied = true;
  }

  req.embedStore = store;
  req.embedDemoMode = demoMode;
  req.embedCanServe =
    canServeChatbot(store, { demoMode }) && !req.embedDomainDenied;
  next();
});
