import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as storeService from '../services/store.service.js';
import * as stripeService from '../services/stripe.service.js';

export const getBillingInfo = asyncHandler(async (req, res) => {
  const info = stripeService.getBillingInfo();

  return sendSuccess(res, 200, 'Billing info retrieved', info);
});

export const createCheckout = asyncHandler(async (req, res) => {
  const store = await storeService.getStoreByUser(req.user);
  const session = await stripeService.createCheckoutSession(store, req.user);

  return sendSuccess(res, 200, 'Checkout session created', session);
});

export const createPortal = asyncHandler(async (req, res) => {
  const store = await storeService.getStoreByUser(req.user);
  const session = await stripeService.createBillingPortalSession(store);

  return sendSuccess(res, 200, 'Billing portal session created', session);
});
