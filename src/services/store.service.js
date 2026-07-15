import Store from '../models/Store.js';
import { getLegalAge } from '../utils/legalAge.js';
import { ApiError } from '../utils/constants.js';
import * as passkitService from './passkit.service.js';

export const getStoreByUser = async (user) => {
  if (!user.storeId) {
    throw new ApiError(404, 'No store associated with this account');
  }

  const store = await Store.findById(user.storeId);

  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  return store;
};

export const updateStoreSettings = async (user, updates, logoFile) => {
  const store = await getStoreByUser(user);

  const allowedFields = [
    'name',
    'brandColor',
    'rewardDescription',
    'stampGoal',
    'productPageUrl',
    'websiteUrl',
    'address',
    'city',
    'country',
    'province',
  ];
  const data = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      data[field] = updates[field];
    }
  }

  const normalizeUrl = (raw, label) => {
    let url = String(raw).trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    try {
      return new URL(url).toString();
    } catch {
      throw new ApiError(400, `Invalid ${label}`);
    }
  };

  if (data.websiteUrl) {
    data.websiteUrl = normalizeUrl(data.websiteUrl, 'website URL');
    if (!data.productPageUrl) {
      data.productPageUrl = data.websiteUrl;
    }
    data.inventorySyncStatus = 'pending';
  }

  if (data.productPageUrl) {
    data.productPageUrl = normalizeUrl(data.productPageUrl, 'website URL');
    if (!data.websiteUrl) {
      data.websiteUrl = data.productPageUrl;
    }
    data.inventorySyncStatus = 'pending';
  }

  if (logoFile) {
    const { uploadImage } = await import('./cloudinary.service.js');
    data.logo = await uploadImage(logoFile.buffer);
  }

  const productUrlChanged =
    (data.productPageUrl && data.productPageUrl !== store.productPageUrl) ||
    (data.websiteUrl && data.websiteUrl !== store.websiteUrl);

  Object.assign(store, data);

  // Ensure legalAge stays aligned when location is updated via settings API
  if (data.country !== undefined || data.province !== undefined || data.address !== undefined) {
    store.legalAge = getLegalAge(store.country, store.province);
  }

  await store.save();

  // Sync branding changes to PassKit program template
  const passkit = await passkitService.syncStoreProgram(store);
  if (passkit.programId) store.passKitProgramId = passkit.programId;
  if (passkit.templateId) store.passKitTemplateId = passkit.templateId;
  if (passkit.programId || passkit.templateId) await store.save();

  // Kick off inventory scrape in the background when product page URL is set/changed
  if (productUrlChanged) {
    import('./inventory.service.js')
      .then(({ syncStoreInventory }) => syncStoreInventory(store._id))
      .catch((error) => {
        console.error('[store] Inventory sync after settings update failed:', error.message);
      });
  }

  return store;
};
