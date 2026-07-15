import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as assistantService from '../services/assistant.service.js';
import * as inventoryService from '../services/inventory.service.js';

export const getWidgetConfig = asyncHandler(async (req, res) => {
  const config = await assistantService.getWidgetConfig(req.params.storeId, {
    store: req.embedStore,
    domainDenied: req.embedDomainDenied,
    demoMode: req.embedDemoMode,
  });
  return sendSuccess(res, 200, 'Widget config retrieved', { config });
});

export const startSession = asyncHandler(async (req, res) => {
  const { storeId, sessionKey } = req.body;
  const session = await assistantService.startSession(storeId, sessionKey, {
    demoMode: req.embedDemoMode,
  });
  return sendSuccess(res, 200, 'Session started', { session });
});

export const sendMessage = asyncHandler(async (req, res) => {
  const { storeId, sessionKey, message } = req.body;
  const result = await assistantService.sendMessage(storeId, sessionKey, message, {
    demoMode: req.embedDemoMode,
  });
  return sendSuccess(res, 200, 'Message processed', { session: result });
});

export const goLive = asyncHandler(async (req, res) => {
  const status = await inventoryService.goLive(req.user);
  return sendSuccess(res, 200, 'Store is live. Chatbot is now active.', { status });
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
  // Prefer quota-aware refresh for dashboard "Refresh Inventory"
  const result = await inventoryService.refreshInventory(req.user);
  return sendSuccess(res, 202, 'Inventory refresh started', result);
});

export const refreshInventory = asyncHandler(async (req, res) => {
  const result = await inventoryService.refreshInventory(req.user);
  return sendSuccess(res, 202, 'Inventory refresh started', result);
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
