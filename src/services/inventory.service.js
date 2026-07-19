import Store from '../models/Store.js';
import StoreInventory from '../models/StoreInventory.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import { filterRecommendableProducts } from '../utils/compliance.js';
import {
  getSubscriptionStatusLabel,
  hasServiceableSubscription,
  isStoreSubscriptionActive,
} from '../utils/subscriptionAccess.js';
import { scrapeStoreProducts } from './scraper.service.js';
import { sanitizeProductPageUrl } from './scraper.catalog.js';
import { buildAndStoreRecommendationTaxonomy } from './taxonomy.service.js';
import {
  abortScrapeJob,
  assertScrapeNotAborted,
  clearScrapeJob,
  registerScrapeJob,
  ScrapeAbortedError,
} from './scrapeJobs.js';

export const MANUAL_REFRESHES_PER_MONTH = 2;

function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function getInventoryRefreshQuota(store) {
  const monthKey = currentMonthKey();
  const count =
    store.inventoryRefreshMonthKey === monthKey ? store.inventoryRefreshCount || 0 : 0;
  const remaining = Math.max(0, MANUAL_REFRESHES_PER_MONTH - count);
  return {
    monthKey,
    used: count,
    limit: MANUAL_REFRESHES_PER_MONTH,
    remaining,
  };
}

function getApiPublicBase() {
  const base = (env.apiPublicUrl || `http://localhost:${env.port}`).replace(/\/+$/, '');
  if (base.includes('localhost:3000')) {
    return `http://localhost:${env.port}`;
  }
  return base;
}

export function buildWidgetScriptUrl() {
  return `${getApiPublicBase()}/widget.js`;
}

export function buildEmbedCode(storeId) {
  // Widget stays hidden until the host site age gate sets age_verified / vapepass_site_age_verified.
  // After that, the chatbot runs its own age check before any recommendations.
  return `<script src="${buildWidgetScriptUrl()}" data-store-id="${storeId}" async></script>`;
}

async function upsertScrapedProduct(storeId, item, now) {
  const externalId = item.externalId || String(item.name || '').toLowerCase();
  if (!externalId) return null;

  const $set = {
    name: item.name,
    brand: item.brand,
    flavor: item.flavor,
    description: item.description ?? null,
    descriptionHash: item.descriptionHash ?? null,
    descriptionSource: item.descriptionSource ?? null,
    imageUrl: item.imageUrl ?? null,
    category: item.category ?? null,
    subcategory: item.subcategory ?? null,
    variantName: item.variantName ?? null,
    parentExternalId: item.parentExternalId ?? null,
    nicotineMgMl: item.nicotineMgMl,
    nicotineStrength: item.nicotineStrength ?? null,
    volumeMl: item.volumeMl,
    bottleSize: item.bottleSize ?? null,
    price: item.price ?? null,
    productType: item.productType,
    platform: item.platform || 'unknown',
    isActive: true,
    status: 'active',
    lastSeenAt: now,
  };

  // Never wipe a previously saved storefront URL if this scrape missed it.
  const cleanedUrl = sanitizeProductPageUrl(item.productUrl);
  if (cleanedUrl) {
    $set.productUrl = cleanedUrl;
  }

  await StoreInventory.findOneAndUpdate(
    { storeId, externalId },
    {
      $set,
      $setOnInsert: {
        isPriorityPromotion: false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return externalId;
}

async function refreshLiveProductCount(storeId) {
  const activeCount = await StoreInventory.countDocuments({
    storeId,
    isActive: true,
  });
  await Store.findByIdAndUpdate(storeId, {
    $set: { inventoryProductCount: activeCount },
  });
  return activeCount;
}

/**
 * Sync inventory for a single store from its website URL.
 * Upserts into store_inventories incrementally (live product count).
 * Preserves isPriorityPromotion across syncs.
 * Supports Force Stop via AbortController — already-saved products are kept.
 *
 * @param {string|import('mongoose').Types.ObjectId} storeId
 * @param {{ isManualRefresh?: boolean, isInitial?: boolean }} [options]
 */
export async function syncStoreInventory(storeId, options = {}) {
  const store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  if (!store.productPageUrl) {
    throw new ApiError(400, 'Store has no website URL configured');
  }

  const controller = registerScrapeJob(store._id);
  const { signal } = controller;

  store.inventorySyncStatus = 'syncing';
  store.inventorySyncError = null;
  store.inventorySyncAttempts = (store.inventorySyncAttempts || 0) + 1;
  await store.save();

  const now = new Date();
  const seenExternalIds = new Set();
  let lastCountWriteAt = 0;
  let platformHint = store.detectedPlatform || null;

  const persistBatch = async (batch = []) => {
    assertScrapeNotAborted(signal);
    if (!batch.length) return;

    for (const item of batch) {
      assertScrapeNotAborted(signal);
      const externalId = await upsertScrapedProduct(store._id, item, now);
      if (externalId) seenExternalIds.add(externalId);
      if (item.platform) platformHint = item.platform;
    }

    // Throttle store count writes so polling sees progress without hammering Mongo
    const t = Date.now();
    if (t - lastCountWriteAt >= 800 || seenExternalIds.size <= 5) {
      lastCountWriteAt = t;
      await refreshLiveProductCount(store._id);
    }
  };

  try {
    const scraped = await scrapeStoreProducts(store.productPageUrl, {
      signal,
      onProductBatch: persistBatch,
    });

    assertScrapeNotAborted(signal);

    // Persist any rows the scraper returned without streaming (safety net)
    const remaining = scraped.filter((item) => {
      const id = item.externalId || String(item.name || '').toLowerCase();
      return id && !seenExternalIds.has(id);
    });
    if (remaining.length) {
      await persistBatch(remaining);
    }

    assertScrapeNotAborted(signal);

    // Full crawl finished — deactivate products no longer on the site
    await StoreInventory.updateMany(
      {
        storeId: store._id,
        isActive: true,
        externalId: { $nin: [...seenExternalIds] },
      },
      { $set: { isActive: false, status: 'inactive' } }
    );

    const activeCount = await refreshLiveProductCount(store._id);
    const fresh = await Store.findById(store._id);
    if (!fresh) throw new ApiError(404, 'Store not found');

    fresh.inventorySyncStatus = 'success';
    fresh.inventorySyncError = null;
    fresh.lastInventorySyncAt = now;
    fresh.inventoryProductCount = activeCount;
    fresh.detectedPlatform = platformHint || scraped[0]?.platform || fresh.detectedPlatform || null;

    if (!fresh.inventoryInitialSyncedAt) {
      fresh.inventoryInitialSyncedAt = now;
    }

    if (fresh.setupCompletedAt && hasServiceableSubscription(fresh)) {
      fresh.assistantEnabled = activeCount > 0;
    } else if (!fresh.setupCompletedAt) {
      fresh.assistantEnabled = false;
    }

    await fresh.save();

    console.log(
      `[inventory] Synced ${activeCount} active products for store ${fresh._id} (variants expanded, no duplicates)`
    );

    try {
      await buildAndStoreRecommendationTaxonomy(fresh._id);
    } catch (error) {
      console.warn(`[inventory] Taxonomy rebuild failed: ${error.message}`);
    }

    return {
      storeId: fresh._id,
      productCount: activeCount,
      platform: fresh.detectedPlatform,
      syncedAt: now,
      isManualRefresh: Boolean(options.isManualRefresh),
      isInitial: Boolean(options.isInitial),
      stopped: false,
    };
  } catch (error) {
    const aborted =
      error instanceof ScrapeAbortedError ||
      error?.name === 'ScrapeAbortedError' ||
      error?.code === 'SCRAPE_ABORTED' ||
      signal.aborted;

    const activeCount = await refreshLiveProductCount(store._id).catch(() => 0);
    const fresh = await Store.findById(store._id);

    if (aborted && fresh) {
      // Keep every product already upserted; do not deactivate unseen SKUs
      fresh.inventorySyncStatus = 'stopped';
      fresh.inventorySyncError = null;
      fresh.inventoryProductCount = activeCount;
      fresh.lastInventorySyncAt = now;
      if (platformHint) fresh.detectedPlatform = platformHint;
      if (activeCount > 0 && !fresh.inventoryInitialSyncedAt) {
        fresh.inventoryInitialSyncedAt = now;
      }
      await fresh.save();
      console.log(
        `[inventory] Scrape stopped for store ${fresh._id} — ${activeCount} products kept`
      );

      if (activeCount > 0) {
        try {
          await buildAndStoreRecommendationTaxonomy(fresh._id);
        } catch (taxError) {
          console.warn(`[inventory] Taxonomy rebuild after stop failed: ${taxError.message}`);
        }
      }

      return {
        storeId: fresh._id,
        productCount: activeCount,
        platform: fresh.detectedPlatform,
        syncedAt: now,
        stopped: true,
        isManualRefresh: Boolean(options.isManualRefresh),
        isInitial: Boolean(options.isInitial),
      };
    }

    console.error(`[inventory] Sync failed for store ${store._id}:`, error.message);
    if (fresh) {
      fresh.inventorySyncStatus = 'error';
      fresh.inventorySyncError = error.message?.slice(0, 1000) || 'Inventory sync failed';
      fresh.inventoryProductCount = activeCount;
      await fresh.save();
    }
    throw error;
  } finally {
    clearScrapeJob(store._id, controller);
  }
}

/**
 * Force-stop an in-progress inventory scrape. Already-saved products are kept.
 */
export async function stopInventorySync(user) {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const store = await Store.findById(user.storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  const wasActive =
    store.inventorySyncStatus === 'syncing' || store.inventorySyncStatus === 'pending';
  const aborted = abortScrapeJob(store._id);

  if (!wasActive && !aborted) {
    throw new ApiError(400, 'No inventory scrape is currently running');
  }

  // If the job registry missed the worker (process restart), flip status immediately
  if (wasActive && !aborted) {
    const activeCount = await StoreInventory.countDocuments({
      storeId: store._id,
      isActive: true,
    });
    store.inventorySyncStatus = 'stopped';
    store.inventorySyncError = null;
    store.inventoryProductCount = activeCount;
    store.lastInventorySyncAt = new Date();
    await store.save();
  }

  const status = await getAssistantStatus(user);
  return {
    stopped: true,
    message: 'Scrape stop requested. Products already saved will be kept.',
    status,
  };
}

/**
 * First inventory scrape after onboarding (URL + serviceable subscription).
 * Does not consume the monthly manual refresh quota.
 */
export async function maybeRunInitialInventorySync(storeId) {
  const store = await Store.findById(storeId);
  if (!store) return null;
  if (!store.productPageUrl && !store.websiteUrl) return null;
  if (!hasServiceableSubscription(store)) return null;
  if (store.inventoryInitialSyncedAt) return null;
  if (store.inventorySyncStatus === 'syncing' || store.inventorySyncStatus === 'pending') {
    return null;
  }

  if (!store.productPageUrl && store.websiteUrl) {
    store.productPageUrl = store.websiteUrl;
    await store.save();
  }

  console.log(`[inventory] Starting initial onboarding scrape for store ${store._id}`);
  return syncStoreInventory(store._id, { isInitial: true });
}

/**
 * Manual Refresh Inventory — limited to 2 per calendar month (UTC) after initial scrape.
 */
export async function refreshInventory(user) {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const store = await Store.findById(user.storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  if (!store.productPageUrl) {
    throw new ApiError(400, 'Save your store website URL before refreshing inventory');
  }

  // First-ever scrape is free (initial)
  if (!store.inventoryInitialSyncedAt) {
    store.inventorySyncStatus = 'syncing';
    store.inventorySyncError = null;
    await store.save();
    syncStoreInventory(store._id, { isInitial: true }).catch((error) => {
      console.error('[inventory] Initial sync failed:', error.message);
    });
    return {
      started: true,
      isInitial: true,
      quota: getInventoryRefreshQuota(store),
      status: await getAssistantStatus(user),
    };
  }

  const quota = getInventoryRefreshQuota(store);
  if (quota.remaining <= 0) {
    throw new ApiError(
      429,
      `Monthly inventory refresh limit reached (${MANUAL_REFRESHES_PER_MONTH}/${MANUAL_REFRESHES_PER_MONTH}). Try again next month.`,
      { code: 'REFRESH_LIMIT', quota }
    );
  }

  const monthKey = currentMonthKey();
  store.inventoryRefreshMonthKey = monthKey;
  store.inventoryRefreshCount = quota.used + 1;
  store.inventorySyncStatus = 'syncing';
  store.inventorySyncError = null;
  await store.save();

  syncStoreInventory(store._id, { isManualRefresh: true }).catch((error) => {
    console.error('[inventory] Manual refresh failed:', error.message);
  });

  return {
    started: true,
    isInitial: false,
    quota: getInventoryRefreshQuota(await Store.findById(store._id)),
    status: await getAssistantStatus(user),
  };
}

/**
 * Sync inventory for all stores that have a website URL.
 */
export async function syncAllStoreInventories() {
  const stores = await Store.find({
    productPageUrl: { $ne: null, $exists: true },
  }).select('_id name productPageUrl');

  const results = {
    total: stores.length,
    success: 0,
    failed: 0,
    details: [],
  };

  for (const store of stores) {
    try {
      const result = await syncStoreInventory(store._id);
      results.success += 1;
      results.details.push({ storeId: store._id, name: store.name, ...result, status: 'success' });
    } catch (error) {
      results.failed += 1;
      results.details.push({
        storeId: store._id,
        name: store.name,
        status: 'error',
        error: error.message,
      });
    }
  }

  console.log(
    `[inventory] Daily sync complete: ${results.success}/${results.total} succeeded, ${results.failed} failed`
  );

  return results;
}

/**
 * Store inventory for dashboard (all or active-only).
 * Priority promotions first, then name.
 */
export async function getStoreInventory(storeId, { activeOnly = true } = {}) {
  const query = { storeId };
  if (activeOnly) query.isActive = true;

  return StoreInventory.find(query)
    .sort({ isPriorityPromotion: -1, name: 1 })
    .lean();
}

/**
 * BC-compliant recommendable inventory for the assistant.
 * Priority promotions are sorted first so the model prioritizes them.
 */
export async function getRecommendableInventory(storeId) {
  const products = await getStoreInventory(storeId, { activeOnly: true });
  const compliant = filterRecommendableProducts(products);
  return compliant.sort((a, b) => {
    if (a.isPriorityPromotion && !b.isPriorityPromotion) return -1;
    if (!a.isPriorityPromotion && b.isPriorityPromotion) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });
}

/**
 * Toggle "Push to Customers This Month" (isPriorityPromotion).
 */
export async function setPriorityPromotion(user, productId, isPriorityPromotion) {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const product = await StoreInventory.findOne({
    _id: productId,
    storeId: user.storeId,
  });

  if (!product) {
    throw new ApiError(404, 'Inventory product not found');
  }

  product.isPriorityPromotion = Boolean(isPriorityPromotion);
  await product.save();

  return product.toObject();
}

/**
 * Set or update the store website URL and optionally trigger an immediate sync.
 */
export async function setProductPageUrl(user, productPageUrl, { syncNow = true } = {}) {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const store = await Store.findById(user.storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  const normalized = normalizeUrl(productPageUrl);
  store.productPageUrl = normalized;
  store.inventorySyncStatus = syncNow ? 'pending' : store.inventorySyncStatus;
  store.inventorySyncError = null;
  await store.save();

  if (syncNow) {
    // Initial or URL-change sync — does not consume refresh quota when first-time
    const isInitial = !store.inventoryInitialSyncedAt;
    syncStoreInventory(store._id, { isInitial }).catch((error) => {
      console.error('[inventory] Immediate sync after URL save failed:', error.message);
    });
  }

  return Store.findById(store._id);
}

function normalizeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) {
    throw new ApiError(400, 'Store website URL is required');
  }

  let withProtocol = trimmed;
  if (!/^https?:\/\//i.test(withProtocol)) {
    withProtocol = `https://${withProtocol}`;
  }

  try {
    const parsed = new URL(withProtocol);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid protocol');
    }
    return parsed.toString();
  } catch {
    throw new ApiError(400, 'Invalid store website URL');
  }
}

/**
 * Assistant status payload for the store dashboard.
 */
export async function getAssistantStatus(user) {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const store = await Store.findById(user.storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  const products = await getStoreInventory(store._id, { activeOnly: false });
  const active = products.filter((p) => p.isActive);
  const recommendable = filterRecommendableProducts(active);
  const priorityCount = active.filter((p) => p.isPriorityPromotion).length;

  const subscriptionActive = hasServiceableSubscription(store);
  const isLive = Boolean(
    store.setupCompletedAt && store.assistantEnabled && recommendable.length > 0 && subscriptionActive
  );
  const refreshQuota = getInventoryRefreshQuota(store);

  // Live count while scraping so the dashboard updates before the job finishes
  let inventoryProductCount = store.inventoryProductCount || 0;
  if (store.inventorySyncStatus === 'syncing' || store.inventorySyncStatus === 'pending') {
    inventoryProductCount = await StoreInventory.countDocuments({
      storeId: store._id,
      isActive: true,
    });
  }

  return {
    storeId: store._id,
    storeName: store.name,
    productPageUrl: store.productPageUrl,
    websiteUrl: store.websiteUrl || store.productPageUrl,
    allowedHostname: store.allowedHostname || null,
    detectedPlatform: store.detectedPlatform || null,
    assistantEnabled: Boolean(store.assistantEnabled && recommendable.length > 0 && subscriptionActive),
    setupCompletedAt: store.setupCompletedAt,
    isLive,
    canGoLive: Boolean(
      subscriptionActive && recommendable.length > 0 && store.productPageUrl
    ),
    paymentFailed: store.subscriptionStatus === 'past_due',
    subscriptionStatus: store.subscriptionStatus,
    subscriptionStatusLabel: getSubscriptionStatusLabel(store.subscriptionStatus),
    subscriptionFullyActive: isStoreSubscriptionActive(store),
    inventorySyncStatus: store.inventorySyncStatus,
    inventorySyncError: store.inventorySyncError,
    lastInventorySyncAt: store.lastInventorySyncAt,
    inventoryInitialSyncedAt: store.inventoryInitialSyncedAt,
    inventoryProductCount,
    recommendableProductCount: recommendable.length,
    priorityPromotionCount: priorityCount,
    inventoryRefresh: {
      remaining: refreshQuota.remaining,
      used: refreshQuota.used,
      limit: refreshQuota.limit,
      label: `Inventory Refreshes Remaining: ${refreshQuota.remaining} / Month`,
    },
    recommendationTaxonomyStatus: store.recommendationTaxonomyStatus || 'idle',
    recommendationTaxonomyBuiltAt: store.recommendationTaxonomyBuiltAt,
    embedCode: buildEmbedCode(store._id),
    widgetScriptUrl: buildWidgetScriptUrl(),
  };
}

/**
 * Finish Setup / Go Live — unlocks the public chatbot for an authorized, subscribed store.
 */
export async function goLive(user) {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const store = await Store.findById(user.storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  if (!hasServiceableSubscription(store)) {
    throw new ApiError(402, 'An active subscription is required before going live');
  }

  if (!store.productPageUrl && !store.websiteUrl) {
    throw new ApiError(400, 'Website URL is required before going live');
  }

  const products = await getStoreInventory(store._id, { activeOnly: true });
  const recommendable = filterRecommendableProducts(products);

  if (!recommendable.length) {
    throw new ApiError(400, 'Sync and push at least one recommendable product before going live');
  }

  store.setupCompletedAt = new Date();
  store.assistantEnabled = true;
  await store.save();

  return getAssistantStatus(user);
}
