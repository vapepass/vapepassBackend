import { ApiError, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import {
  canAccessDashboard,
  getSubscriptionStatusLabel,
  isSubscriptionActive,
} from '../utils/subscriptionAccess.js';
import { asyncHandler } from './asyncHandler.js';
import { resolveStore } from './resolveStore.js';

const HARD_LOCKED = [
  SUBSCRIPTION_STATUS.TRIAL,
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.PAUSED,
  SUBSCRIPTION_STATUS.EXPIRED,
];

/**
 * Blocks dashboard / management actions when subscription is locked.
 * Allows `active` and `past_due` (Payment Failed during Stripe retry window)
 * so status can be shown inside the dashboard. Fully locks after pause/expiry.
 */
export const requireActiveSubscription = [
  resolveStore,
  asyncHandler(async (req, res, next) => {
    if (!canAccessDashboard(req.store.subscriptionStatus)) {
      throw new ApiError(
        402,
        'Your subscription is inactive. Please complete billing to unlock the dashboard.',
        {
          code: 'SUBSCRIPTION_REQUIRED',
          subscriptionStatus: req.store.subscriptionStatus,
          subscriptionStatusLabel: getSubscriptionStatusLabel(req.store.subscriptionStatus),
        }
      );
    }

    next();
  }),
];

/**
 * Soft check that attaches subscription metadata without blocking.
 */
export const attachSubscriptionMeta = [
  resolveStore,
  asyncHandler(async (req, res, next) => {
    req.subscriptionMeta = {
      status: req.store.subscriptionStatus,
      label: getSubscriptionStatusLabel(req.store.subscriptionStatus),
      active: isSubscriptionActive(req.store.subscriptionStatus),
      dashboardAccess: canAccessDashboard(req.store.subscriptionStatus),
      blocked: HARD_LOCKED.includes(req.store.subscriptionStatus),
      paymentFailed: req.store.subscriptionStatus === SUBSCRIPTION_STATUS.PAST_DUE,
      startDate: req.store.subscriptionStartDate,
      endDate: req.store.subscriptionEndDate,
      nextBillingDate: req.store.nextBillingDate,
    };
    next();
  }),
];
