import Store from '../models/Store.js';
import StoreInventory from '../models/StoreInventory.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import { filterRecommendableProducts } from '../utils/compliance.js';
import { scrapeStoreProducts } from './scraper.service.js';

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

/**
 * Sync inventory for a single store from its website URL.
 * Upserts into store_inventories — never creates duplicates.
 * Preserves isPriorityPromotion across syncs.
 */
export async function syncStoreInventory(storeId) {
  const store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  if (!store.productPageUrl) {
    throw new ApiError(400, 'Store has no website URL configured');
  }

  store.inventorySyncStatus = 'syncing';
  store.inventorySyncError = null;
  store.inventorySyncAttempts = (store.inventorySyncAttempts || 0) + 1;
  await store.save();

  try {
    const scraped = await scrapeStoreProducts(store.productPageUrl);
    const now = new Date();
    const seenExternalIds = new Set();

    for (const item of scraped) {
      const externalId = item.externalId || item.name.toLowerCase();
      seenExternalIds.add(externalId);

      await StoreInventory.findOneAndUpdate(
        { storeId: store._id, externalId },
        {
          $set: {
            name: item.name,
            brand: item.brand,
            flavor: item.flavor,
            nicotineMgMl: item.nicotineMgMl,
            volumeMl: item.volumeMl,
            productType: item.productType,
            productUrl: item.productUrl,
            platform: item.platform || 'unknown',
            isActive: true,
            status: 'active',
            lastSeenAt: now,
          },
          $setOnInsert: {
            isPriorityPromotion: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    // Products no longer on the site are deactivated (chatbot stops recommending them)
    await StoreInventory.updateMany(
      {
        storeId: store._id,
        isActive: true,
        externalId: { $nin: [...seenExternalIds] },
      },
      { $set: { isActive: false, status: 'inactive' } }
    );

    const activeCount = await StoreInventory.countDocuments({
      storeId: store._id,
      isActive: true,
    });

    store.inventorySyncStatus = 'success';
    store.inventorySyncError = null;
    store.lastInventorySyncAt = now;
    store.inventoryProductCount = activeCount;
    store.assistantEnabled = activeCount > 0;
    store.detectedPlatform = scraped[0]?.platform || store.detectedPlatform || null;
    await store.save();

    console.log(
      `[inventory] Synced ${activeCount} active products for store ${store._id} (no duplicates)`
    );

    return {
      storeId: store._id,
      productCount: activeCount,
      platform: store.detectedPlatform,
      syncedAt: now,
    };
  } catch (error) {
    console.error(`[inventory] Sync failed for store ${store._id}:`, error.message);
    store.inventorySyncStatus = 'error';
    store.inventorySyncError = error.message?.slice(0, 1000) || 'Inventory sync failed';
    await store.save();
    throw error;
  }
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
    syncStoreInventory(store._id).catch((error) => {
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

  return {
    storeId: store._id,
    storeName: store.name,
    productPageUrl: store.productPageUrl,
    detectedPlatform: store.detectedPlatform || null,
    assistantEnabled: Boolean(store.assistantEnabled && recommendable.length > 0),
    inventorySyncStatus: store.inventorySyncStatus,
    inventorySyncError: store.inventorySyncError,
    lastInventorySyncAt: store.lastInventorySyncAt,
    inventoryProductCount: store.inventoryProductCount,
    recommendableProductCount: recommendable.length,
    priorityPromotionCount: priorityCount,
    embedCode: buildEmbedCode(store._id),
    widgetScriptUrl: buildWidgetScriptUrl(),
  };
}
