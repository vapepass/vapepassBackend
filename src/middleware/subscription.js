import Store from '../models/Store.js';
import { ApiError, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { asyncHandler } from './asyncHandler.js';

/**
 * Blocks dashboard actions when subscription is paused or cancelled.
 */
export const requireActiveSubscription = asyncHandler(async (req, res, next) => {
  if (!req.user?.storeId) {
    throw new ApiError(403, 'No store associated with this account');
  }

  const store = await Store.findById(req.user.storeId).select('subscriptionStatus name');

  if (!store) throw new ApiError(404, 'Store not found');

  const blocked = [SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.PAUSED];

  if (blocked.includes(store.subscriptionStatus)) {
    throw new ApiError(
      402,
      'Your subscription is inactive. Please update billing in Business Settings to continue.'
    );
  }

  req.store = store;
  next();
});
