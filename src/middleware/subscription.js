import { ApiError, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { asyncHandler } from './asyncHandler.js';
import { resolveStore } from './resolveStore.js';

const BLOCKED_STATUSES = [
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.PAUSED,
];

/**
 * Blocks dashboard actions when subscription is inactive.
 * Requires resolveStore (or sets req.store via resolveStore logic).
 */
export const requireActiveSubscription = [
  resolveStore,
  asyncHandler(async (req, res, next) => {
    if (BLOCKED_STATUSES.includes(req.store.subscriptionStatus)) {
      throw new ApiError(
        402,
        'Your subscription is inactive. Please update billing in Business Settings to continue.'
      );
    }

    next();
  }),
];
