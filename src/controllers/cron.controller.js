import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as inventoryService from '../services/inventory.service.js';

/**
 * Daily inventory sync for all stores (Vercel Cron / external scheduler).
 */
export const syncAllInventories = asyncHandler(async (_req, res) => {
  console.log('[cron] Starting daily inventory sync');
  const results = await inventoryService.syncAllStoreInventories();
  return sendSuccess(res, 200, 'Daily inventory sync completed', { results });
});
