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
    'address',
    'country',
    'province',
  ];
  const data = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      data[field] = updates[field];
    }
  }

  if (data.productPageUrl) {
    let url = String(data.productPageUrl).trim();
    if (url && !/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    try {
      data.productPageUrl = new URL(url).toString();
      data.inventorySyncStatus = 'pending';
    } catch {
      throw new ApiError(400, 'Invalid product page URL');
    }
  }

  if (logoFile) {
    const { uploadImage } = await import('./cloudinary.service.js');
    data.logo = await uploadImage(logoFile.buffer);
  }

  const productUrlChanged =
    data.productPageUrl && data.productPageUrl !== store.productPageUrl;

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
