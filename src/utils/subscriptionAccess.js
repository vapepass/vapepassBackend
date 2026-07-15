import { SUBSCRIPTION_STATUS } from './constants.js';

/** Fully paid / healthy subscription */
export const ACTIVE_SUBSCRIPTION_STATUSES = [SUBSCRIPTION_STATUS.ACTIVE];

/**
 * Dashboard remains usable during Payment Failed (Stripe retry window).
 * Chatbot also remains available until paused after exhausted retries.
 */
export const DASHBOARD_ACCESS_STATUSES = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAST_DUE,
];

/** Statuses that fully lock the dashboard (must subscribe / update billing) */
export const LOCKED_SUBSCRIPTION_STATUSES = [
  SUBSCRIPTION_STATUS.TRIAL,
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.PAUSED,
  SUBSCRIPTION_STATUS.EXPIRED,
];

/**
 * Human-readable subscription labels for the dashboard UI.
 */
export const SUBSCRIPTION_STATUS_LABELS = {
  [SUBSCRIPTION_STATUS.ACTIVE]: 'Active',
  [SUBSCRIPTION_STATUS.PAUSED]: 'Paused',
  [SUBSCRIPTION_STATUS.PAST_DUE]: 'Payment Failed',
  [SUBSCRIPTION_STATUS.EXPIRED]: 'Expired',
  [SUBSCRIPTION_STATUS.CANCELLED]: 'Expired',
  [SUBSCRIPTION_STATUS.TRIAL]: 'Pending Payment',
};

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isSubscriptionActive(status) {
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(status);
}

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function canAccessDashboard(status) {
  return DASHBOARD_ACCESS_STATUSES.includes(status);
}

/**
 * @param {{ subscriptionStatus?: string }|null|undefined} store
 * @returns {boolean}
 */
export function isStoreSubscriptionActive(store) {
  return Boolean(store && isSubscriptionActive(store.subscriptionStatus));
}

/**
 * Active or payment-failed (retry window) — chatbot may stay up until pause.
 * @param {{ subscriptionStatus?: string }|null|undefined} store
 */
export function hasServiceableSubscription(store) {
  if (!store) return false;
  return canAccessDashboard(store.subscriptionStatus);
}

/**
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function getSubscriptionStatusLabel(status) {
  return SUBSCRIPTION_STATUS_LABELS[status] || 'Unknown';
}

/**
 * Whether the public chatbot may load for this store (subscription + go-live).
 * Demo mode (marketing site) can serve when inventory is ready even before billing.
 * @param {object} store
 * @param {{ demoMode?: boolean }} [options]
 * @returns {boolean}
 */
export function canServeChatbot(store, options = {}) {
  if (!store) return false;
  if (!store.productPageUrl && !store.websiteUrl) return false;

  if (options.demoMode) {
    return Boolean(store.assistantEnabled || store.setupCompletedAt || store.inventoryProductCount > 0);
  }

  if (!hasServiceableSubscription(store)) return false;
  if (!store.assistantEnabled) return false;
  return true;
}
