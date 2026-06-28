import Store from '../models/Store.js';
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

  const allowedFields = ['name', 'brandColor', 'rewardDescription', 'stampGoal'];
  const data = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      data[field] = updates[field];
    }
  }

  if (logoFile) {
    const { uploadImage } = await import('./cloudinary.service.js');
    data.logo = await uploadImage(logoFile.buffer);
  }

  Object.assign(store, data);
  await store.save();

  // Sync branding changes to PassKit program template
  const passkit = await passkitService.syncStoreProgram(store);
  if (passkit.programId) store.passKitProgramId = passkit.programId;
  if (passkit.templateId) store.passKitTemplateId = passkit.templateId;
  if (passkit.programId || passkit.templateId) await store.save();

  return store;
};
