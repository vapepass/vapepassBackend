import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as storeService from '../services/store.service.js';

export const getStore = asyncHandler(async (req, res) => {
  const store = await storeService.getStoreByUser(req.user);

  return sendSuccess(res, 200, 'Store retrieved successfully', { store });
});

export const updateStoreSettings = asyncHandler(async (req, res) => {
  const store = await storeService.updateStoreSettings(
    req.user,
    req.body,
    req.file
  );

  return sendSuccess(res, 200, 'Store settings updated successfully', { store });
});
