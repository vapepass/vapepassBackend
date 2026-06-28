import { SUBSCRIPTION_STATUS } from '../utils/constants.js';

/**
 * Maps Stripe subscription / invoice statuses to internal subscriptionStatus values.
 */
export function mapStripeSubscriptionStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') {
    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') {
    return SUBSCRIPTION_STATUS.PAST_DUE;
  }

  if (stripeStatus === 'canceled' || stripeStatus === 'cancelled') {
    return SUBSCRIPTION_STATUS.CANCELLED;
  }

  if (stripeStatus === 'paused') {
    return SUBSCRIPTION_STATUS.PAUSED;
  }

  return null;
}
