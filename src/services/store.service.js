import Store from '../models/Store.js';
import { getLegalAge } from '../utils/legalAge.js';
import { ApiError } from '../utils/constants.js';
import { extractHostname } from '../utils/domain.js';
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
    'allowedHostname',
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
  }

  if (data.productPageUrl) {
    data.productPageUrl = normalizeUrl(data.productPageUrl, 'website URL');
    if (!data.websiteUrl) {
      data.websiteUrl = data.productPageUrl;
    }
  }

  // Authorized embed domain — replaces the previous one (single active hostname).
  // Accepts full URLs (http://localhost:3000) or bare hosts (staging.example.com).
  if (data.allowedHostname !== undefined) {
    const hostname = extractHostname(data.allowedHostname);
    if (!hostname) {
      throw new ApiError(
        400,
        'Invalid authorized domain. Enter a URL or hostname (e.g. https://mystore.com or localhost).'
      );
    }
    data.allowedHostname = hostname;
  }

  if (logoFile) {
    const { uploadImage } = await import('./cloudinary.service.js');
    data.logo = await uploadImage(logoFile.buffer);
  }

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

  // Do not auto-scrape when the website URL changes in Settings.
  // Inventory import/refresh is started only from the AI Assistant page.

  return store;
};
