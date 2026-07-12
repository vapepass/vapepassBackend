import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as assistantService from '../services/assistant.service.js';
import * as inventoryService from '../services/inventory.service.js';

export const getWidgetConfig = asyncHandler(async (req, res) => {
  const config = await assistantService.getWidgetConfig(req.params.storeId);
  return sendSuccess(res, 200, 'Widget config retrieved', { config });
});

export const startSession = asyncHandler(async (req, res) => {
  const { storeId, sessionKey } = req.body;
  const session = await assistantService.startSession(storeId, sessionKey);
  return sendSuccess(res, 200, 'Session started', { session });
});

export const sendMessage = asyncHandler(async (req, res) => {
  const { storeId, sessionKey, message } = req.body;
  const result = await assistantService.sendMessage(storeId, sessionKey, message);
  return sendSuccess(res, 200, 'Message processed', { session: result });
});

export const getAssistantStatus = asyncHandler(async (req, res) => {
  const status = await inventoryService.getAssistantStatus(req.user);
  return sendSuccess(res, 200, 'Assistant status retrieved', { status });
});

export const setProductPageUrl = asyncHandler(async (req, res) => {
  const syncNow = req.body.syncNow !== false;
  const store = await inventoryService.setProductPageUrl(
    req.user,
    req.body.productPageUrl,
    { syncNow }
  );
  const status = await inventoryService.getAssistantStatus(req.user);
  return sendSuccess(res, 200, 'Product page URL saved', { store, status });
});

export const syncInventory = asyncHandler(async (req, res) => {
  const Store = (await import('../models/Store.js')).default;
  await Store.findByIdAndUpdate(req.user.storeId, {
    inventorySyncStatus: 'syncing',
    inventorySyncError: null,
  });

  // Start sync in background; client polls /assistant/status for completion
  inventoryService.syncStoreInventory(req.user.storeId).catch((error) => {
    console.error('[assistant] Manual inventory sync failed:', error.message);
  });

  const status = await inventoryService.getAssistantStatus(req.user);
  return sendSuccess(res, 202, 'Inventory sync started', { status });
});

export const listInventory = asyncHandler(async (req, res) => {
  const products = await inventoryService.getStoreInventory(req.user.storeId, {
    activeOnly: req.query.activeOnly !== 'false',
  });
  return sendSuccess(res, 200, 'Inventory retrieved', { products });
});

export const setPriorityPromotion = asyncHandler(async (req, res) => {
  const product = await inventoryService.setPriorityPromotion(
    req.user,
    req.params.productId,
    req.body.isPriorityPromotion
  );
  return sendSuccess(res, 200, 'Priority promotion updated', { product });
});
