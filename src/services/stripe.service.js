import { env } from '../config/env.js';
import Store from '../models/Store.js';
import User from '../models/User.js';
import ProcessedStripeEvent from '../models/ProcessedStripeEvent.js';
import { ApiError, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { mapStripeSubscriptionStatus } from '../utils/stripeStatus.js';
import {
  sendPaymentFailedEmail,
  sendSubscriptionActivatedEmail,
  sendSubscriptionPausedEmail,
} from './email.service.js';

const MONTHLY_PRICE_CENTS = 9900; // $99/month
const MAX_PAYMENT_RETRIES = 2;

const isConfigured = () => Boolean(env.stripe.secretKey);

async function findStoreFromStripeObject(obj) {
  if (obj.metadata?.storeId) {
    const store = await Store.findById(obj.metadata.storeId);
    if (store) return store;
  }

  const customerId =
    typeof obj.customer === 'string' ? obj.customer : obj.customer?.id || null;

  if (customerId) {
    const store = await Store.findOne({ stripeCustomerId: customerId });
    if (store) return store;
  }

  const subscriptionId =
    typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id || obj.id;

  if (subscriptionId) {
    const store = await Store.findOne({ stripeSubscriptionId: subscriptionId });
    if (store) return store;
  }

  return null;
}

async function getStoreOwnerEmail(store) {
  const owner = await User.findById(store.createdBy).select('email');
  return owner?.email || null;
}

function applyPeriodDates(store, stripeSubscription) {
  if (!stripeSubscription) return;

  const start =
    stripeSubscription.current_period_start ||
    stripeSubscription.start_date ||
    stripeSubscription.billing_cycle_anchor;
  const end = stripeSubscription.current_period_end;

  if (start) {
    store.subscriptionStartDate = new Date(start * 1000);
  }
  if (end) {
    store.subscriptionEndDate = new Date(end * 1000);
    store.nextBillingDate = new Date(end * 1000);
  }
}

async function pauseStoreForFailedPayment(store) {
  store.subscriptionStatus = SUBSCRIPTION_STATUS.PAUSED;
  store.assistantEnabled = false;
  store.paymentRetryCount = MAX_PAYMENT_RETRIES;

  const email = await getStoreOwnerEmail(store);
  if (email) {
    await sendSubscriptionPausedEmail(email, { storeName: store.name });
  }
}

async function activateStoreSubscription(store, stripeSubscription) {
  const wasActive = store.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE;

  store.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
  store.paymentRetryCount = 0;
  store.lastPaymentFailedAt = null;

  // New / reactivated subscriptions renew automatically unless the owner opted out
  if (typeof store.autoRenew !== 'boolean') {
    store.autoRenew = true;
  }

  if (stripeSubscription) {
    store.stripeSubscriptionId = stripeSubscription.id || store.stripeSubscriptionId;
    applyPeriodDates(store, stripeSubscription);
    // Never flip an explicit opt-out back to ON from a Stripe payload that
    // still has cancel_at_period_end=false (collection drift). Prefer store flag.
    if (store.autoRenew === false) {
      /* keep false — ensureStripeMatchesAutoRenew heals Stripe separately */
    } else if (typeof stripeSubscription.cancel_at_period_end === 'boolean') {
      store.autoRenew = !stripeSubscription.cancel_at_period_end;
    }
  }

  if (!store.subscriptionStartDate) {
    store.subscriptionStartDate = new Date();
  }
  if (!store.subscriptionEndDate) {
    const end = new Date();
    end.setDate(end.getDate() + 30);
    store.subscriptionEndDate = end;
    store.nextBillingDate = end;
  }

  // Re-enable chatbot only if the store previously completed setup
  if (store.setupCompletedAt) {
    store.assistantEnabled = true;
  }

  if (!wasActive) {
    const email = await getStoreOwnerEmail(store);
    if (email) {
      await sendSubscriptionActivatedEmail(email, {
        storeName: store.name,
        startDate: store.subscriptionStartDate,
        endDate: store.subscriptionEndDate,
      });
    }

    // Auto-run first inventory scrape after subscription unlock + URL present
    if (store.productPageUrl || store.websiteUrl) {
      const { maybeRunInitialInventorySync } = await import('./inventory.service.js');
      maybeRunInitialInventorySync(store._id).catch((error) => {
        console.warn('[stripe] Initial inventory scrape failed:', error.message);
      });
    }
  }
}

/**
 * Update Stripe so Auto Subscription preference is enforced end-to-end.
 * autoRenew ON  → renews: cancel_at_period_end false, collection resumed
 * autoRenew OFF → no automatic renewal/charges: cancel_at_period_end true,
 *                 pause_collection, and stop auto_advance on open invoices
 *                 (manual Retry Payment still uses invoices.pay).
 */
async function syncStripeCancelAtPeriodEnd(store, autoRenew) {
  if (!store.stripeSubscriptionId || !isConfigured()) return null;

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.stripe.secretKey);
  const cancelAtPeriodEnd = !autoRenew;

  const updatePayload = {
    cancel_at_period_end: cancelAtPeriodEnd,
  };

  if (autoRenew) {
    // Empty string clears pause_collection (Stripe API)
    updatePayload.pause_collection = '';
  } else {
    updatePayload.pause_collection = { behavior: 'keep_as_draft' };
  }

  const subscription = await stripe.subscriptions.update(store.stripeSubscriptionId, updatePayload);

  applyPeriodDates(store, subscription);

  if (!autoRenew) {
    await stopAutomaticCollectionOnOpenInvoices(stripe, store);
  }

  return subscription;
}

/**
 * Halt Stripe Smart Retries / auto_advance on open invoices.
 * Does not void invoices — manual retry can still call invoices.pay.
 */
async function stopAutomaticCollectionOnOpenInvoices(stripe, store) {
  try {
    const listParams = { status: 'open', limit: 10 };
    if (store.stripeSubscriptionId) {
      listParams.subscription = store.stripeSubscriptionId;
    } else if (store.stripeCustomerId) {
      listParams.customer = store.stripeCustomerId;
    } else {
      return;
    }

    const openInvoices = await stripe.invoices.list(listParams);
    for (const invoice of openInvoices.data || []) {
      if (!invoice?.id) continue;
      if (invoice.auto_advance === false) continue;
      try {
        await stripe.invoices.update(invoice.id, { auto_advance: false });
      } catch (error) {
        console.warn(
          `[billing] Unable to disable auto_advance on ${invoice.id}:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.warn('[billing] Unable to stop open-invoice auto collection:', error.message);
  }
}

/**
 * Re-assert Stripe collection settings from the store's autoRenew flag.
 * Used when billing sync / webhooks detect drift (e.g. portal changes).
 */
async function ensureStripeMatchesAutoRenew(store, subscription = null) {
  if (!store?.stripeSubscriptionId || !isConfigured()) return subscription;

  const wantsRenew = store.autoRenew !== false;
  const cancelAtPeriodEnd = Boolean(subscription?.cancel_at_period_end);
  const isPaused = Boolean(subscription?.pause_collection);

  const drift =
    (wantsRenew && (cancelAtPeriodEnd || isPaused)) ||
    (!wantsRenew && (!cancelAtPeriodEnd || !isPaused));

  if (!drift && wantsRenew) return subscription;
  if (!drift && !wantsRenew) {
    // Still stop any open invoice retries even if cancel_at_period_end already true
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.stripe.secretKey);
    await stopAutomaticCollectionOnOpenInvoices(stripe, store);
    return subscription;
  }

  try {
    return await syncStripeCancelAtPeriodEnd(store, wantsRenew);
  } catch (error) {
    console.warn('[billing] Unable to re-sync autoRenew to Stripe:', error.message);
    return subscription;
  }
}

/**
 * Persist Auto Subscription preference and sync with Stripe.
 */
export async function setAutoRenew(store, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new ApiError(400, 'enabled must be a boolean');
  }

  const { canAccessDashboard } = await import('../utils/subscriptionAccess.js');
  if (!canAccessDashboard(store?.subscriptionStatus)) {
    throw new ApiError(
      403,
      'Auto Subscription can only be changed while your subscription is active.'
    );
  }

  if (!store.stripeSubscriptionId) {
    throw new ApiError(
      400,
      'No active Stripe subscription found. Subscribe first, then manage Auto Subscription.'
    );
  }

  if (!isConfigured()) {
    throw new ApiError(503, 'Stripe is not configured. Add STRIPE_SECRET_KEY to .env');
  }

  const current = store.autoRenew !== false;
  if (current === enabled) {
    return {
      autoRenew: current,
      autoRenewUpdatedAt: store.autoRenewUpdatedAt || null,
      nextBillingDate: store.nextBillingDate || null,
      subscriptionEndDate: store.subscriptionEndDate || null,
    };
  }

  const subscription = await syncStripeCancelAtPeriodEnd(store, enabled);
  store.autoRenew = enabled;
  store.autoRenewUpdatedAt = new Date();
  await store.save();

  return {
    autoRenew: store.autoRenew,
    autoRenewUpdatedAt: store.autoRenewUpdatedAt,
    nextBillingDate: store.nextBillingDate || null,
    subscriptionEndDate: store.subscriptionEndDate || null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
  };
}

/**
 * Stripe billing service.
 * Prefers STRIPE_PRICE_ID; falls back to inline $99/mo price_data when unset.
 */
export const createCheckoutSession = async (store, user) => {
  if (!isConfigured()) {
    throw new ApiError(503, 'Stripe is not configured. Add STRIPE_SECRET_KEY to .env');
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.stripe.secretKey);

  let customerId = store.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      metadata: { storeId: String(store._id) },
    });
    customerId = customer.id;
    store.stripeCustomerId = customerId;
    await store.save();
  }

  const priceId = String(env.stripe.priceId || '').trim();
  const lineItems = priceId
    ? [{ price: priceId, quantity: 1 }]
    : [
        {
          price_data: {
            currency: 'usd',
            unit_amount: MONTHLY_PRICE_CENTS,
            recurring: { interval: 'month' },
            product_data: {
              name: 'VapePass Pro',
              description: 'Monthly subscription — dashboard, embed script, and AI assistant',
            },
          },
          quantity: 1,
        },
      ];

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    success_url: `${env.clientUrl}/subscribe?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.clientUrl}/subscribe?billing=cancelled`,
    metadata: { storeId: String(store._id) },
    subscription_data: {
      metadata: { storeId: String(store._id) },
    },
  });

  return { url: session.url, sessionId: session.id };
};

/**
 * Confirm checkout after Stripe redirects back.
 * Works locally without webhooks by verifying the Checkout Session via Stripe API.
 */
export const confirmCheckoutSession = async (store, sessionId) => {
  if (!isConfigured()) {
    throw new ApiError(503, 'Stripe is not configured');
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.stripe.secretKey);

  let session = null;

  if (sessionId) {
    session = await stripe.checkout.sessions.retrieve(String(sessionId), {
      expand: ['subscription'],
    });

    const sessionStoreId = session.metadata?.storeId;
    if (sessionStoreId && String(sessionStoreId) !== String(store._id)) {
      throw new ApiError(403, 'Checkout session does not belong to this store');
    }

    if (session.customer && !store.stripeCustomerId) {
      store.stripeCustomerId =
        typeof session.customer === 'string' ? session.customer : session.customer.id;
    }
  } else if (store.stripeCustomerId) {
    // Fallback when webhooks are unavailable and session_id is missing (e.g. old redirect URL)
    const sessions = await stripe.checkout.sessions.list({
      customer: store.stripeCustomerId,
      limit: 5,
    });
    session = sessions.data.find(
      (item) =>
        item.mode === 'subscription' &&
        item.payment_status === 'paid' &&
        (item.metadata?.storeId ? String(item.metadata.storeId) === String(store._id) : true)
    );
  }

  if (!session) {
    // Last resort: any active subscription on this Stripe customer
    if (store.stripeCustomerId) {
      const subscriptions = await stripe.subscriptions.list({
        customer: store.stripeCustomerId,
        status: 'active',
        limit: 1,
      });
      if (subscriptions.data[0]) {
        await activateStoreSubscription(store, subscriptions.data[0]);
        await store.save();
        return store;
      }
    }
    throw new ApiError(400, 'No completed payment found yet. Please wait a moment and try again.');
  }

  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    throw new ApiError(402, 'Payment is not complete yet');
  }

  let subscription = session.subscription;
  if (typeof subscription === 'string') {
    subscription = await stripe.subscriptions.retrieve(subscription);
  }

  if (!subscription) {
    throw new ApiError(400, 'Subscription not found on checkout session');
  }

  await activateStoreSubscription(store, subscription);
  await store.save();
  return store;
};

export const createBillingPortalSession = async (store) => {
  if (!isConfigured()) {
    throw new ApiError(503, 'Stripe is not configured');
  }

  if (!store.stripeCustomerId) {
    throw new ApiError(400, 'No billing account found. Subscribe first.');
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.stripe.secretKey);

  const session = await stripe.billingPortal.sessions.create({
    customer: store.stripeCustomerId,
    return_url: `${env.clientUrl}/settings?tab=billing`,
  });

  return { url: session.url };
};

/**
 * Map Stripe card/decline errors to clear, customer-facing copy.
 */
function friendlyPaymentError(error) {
  const code = String(error?.decline_code || error?.code || '').toLowerCase();
  const messages = {
    card_declined: 'Your card was declined. Please update your payment method and try again.',
    insufficient_funds: 'Your card has insufficient funds. Please use another payment method and try again.',
    expired_card: 'Your card has expired. Please update your payment method and try again.',
    incorrect_cvc: 'The security code (CVC) appears to be incorrect. Please update your payment method and try again.',
    processing_error: 'We could not process your payment due to a temporary issue. Please try again in a few minutes.',
    authentication_required:
      'Your bank requires additional authentication. Update your payment method in Manage Subscription, then retry.',
  };

  if (messages[code]) return messages[code];

  if (error?.type === 'StripeCardError' || error?.rawType === 'card_error') {
    return 'Your payment could not be processed. Please update your payment method and try again.';
  }

  return 'We could not process your renewal payment. Please update your payment method and try again.';
}

async function findOpenRenewalInvoice(stripe, store) {
  const listParams = {
    status: 'open',
    limit: 5,
  };

  if (store.stripeSubscriptionId) {
    listParams.subscription = store.stripeSubscriptionId;
  } else if (store.stripeCustomerId) {
    listParams.customer = store.stripeCustomerId;
  } else {
    return null;
  }

  const openInvoices = await stripe.invoices.list(listParams);
  const unpaid = (openInvoices.data || []).find(
    (inv) => inv.amount_due > 0 && ['open', 'uncollectible'].includes(inv.status)
  );
  if (unpaid) return unpaid;

  // Fallback: latest invoice on the subscription (may still be open)
  if (store.stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(store.stripeSubscriptionId);
    const latestId =
      typeof subscription.latest_invoice === 'string'
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id;
    if (latestId) {
      const latest = await stripe.invoices.retrieve(latestId);
      if (latest && latest.amount_due > 0 && ['open', 'draft', 'uncollectible'].includes(latest.status)) {
        if (latest.status === 'draft') {
          return stripe.invoices.finalizeInvoice(latest.id);
        }
        return latest;
      }
    }
  }

  return null;
}

/**
 * Retry a failed renewal against the existing Stripe subscription / open invoice.
 * Does not create a new customer or subscription.
 */
export const retryFailedPayment = async (store) => {
  if (!isConfigured()) {
    throw new ApiError(503, 'Billing is temporarily unavailable. Please try again later.');
  }

  if (!store.stripeSubscriptionId && !store.stripeCustomerId) {
    throw new ApiError(400, 'No subscription found to retry. Please subscribe first.');
  }

  const retryable = [SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PAUSED];
  if (!retryable.includes(store.subscriptionStatus)) {
    throw new ApiError(
      400,
      'Your subscription does not have a failed payment to retry right now.'
    );
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.stripe.secretKey);

  let invoice;
  try {
    invoice = await findOpenRenewalInvoice(stripe, store);
  } catch (error) {
    console.warn('[billing] Failed to locate open invoice:', error.message);
    throw new ApiError(
      400,
      'We could not find an outstanding renewal invoice. Please use Manage Subscription to update your payment method.'
    );
  }

  if (!invoice) {
    throw new ApiError(
      400,
      'There is no outstanding renewal payment right now. If you recently updated your card, refresh this page or use Manage Subscription.'
    );
  }

  let paidInvoice;
  try {
    paidInvoice = await stripe.invoices.pay(invoice.id);
  } catch (error) {
    store.lastPaymentFailedAt = new Date();
    store.paymentRetryCount = (store.paymentRetryCount || 0) + 1;
    store.subscriptionStatus = SUBSCRIPTION_STATUS.PAST_DUE;
    await store.save();
    throw new ApiError(402, friendlyPaymentError(error));
  }

  if (paidInvoice.status !== 'paid') {
    store.lastPaymentFailedAt = new Date();
    store.subscriptionStatus = SUBSCRIPTION_STATUS.PAST_DUE;
    await store.save();
    throw new ApiError(
      402,
      'Your payment could not be completed. Please update your payment method and try again.'
    );
  }

  let subscription = null;
  if (store.stripeSubscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(store.stripeSubscriptionId);
    } catch {
      subscription = {
        id: store.stripeSubscriptionId,
        current_period_end: paidInvoice.lines?.data?.[0]?.period?.end,
        current_period_start: paidInvoice.lines?.data?.[0]?.period?.start,
      };
    }
  }

  await activateStoreSubscription(store, subscription);
  await store.save();

  return {
    store,
    invoiceId: paidInvoice.id,
    amountPaid: (paidInvoice.amount_paid || 0) / 100,
    currency: (paidInvoice.currency || 'usd').toUpperCase(),
    billing: await getBillingInfo(store),
  };
};

/**
 * Best-effort open-invoice summary for Billing UI (no schema changes).
 */
async function resolveOpenInvoiceSummary(store) {
  if (!store || !isConfigured()) return null;
  if (!store.stripeSubscriptionId && !store.stripeCustomerId) return null;

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.stripe.secretKey);
    const invoice = await findOpenRenewalInvoice(stripe, store);
    if (!invoice) return null;

    const failureCode =
      invoice.last_finalization_error?.code ||
      invoice.charge?.failure_code ||
      null;

    return {
      id: invoice.id,
      amountDue: (invoice.amount_due || 0) / 100,
      currency: (invoice.currency || 'usd').toUpperCase(),
      status: invoice.status,
      attempted: Boolean(invoice.attempted),
      nextPaymentAttempt: invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000)
        : null,
      failureCode,
      failureMessage: failureCode
        ? friendlyPaymentError({ code: failureCode, decline_code: failureCode })
        : null,
    };
  } catch (error) {
    console.warn('[billing] Unable to load open invoice:', error.message);
    return null;
  }
}

export const handleWebhookEvent = async (event) => {
  const alreadyProcessed = await ProcessedStripeEvent.findOne({ eventId: event.id });
  if (alreadyProcessed) {
    return { duplicate: true };
  }

  const obj = event.data.object;
  const store = await findStoreFromStripeObject(obj);

  if (!store) {
    await ProcessedStripeEvent.create({ eventId: event.id, type: event.type });
    return { storeFound: false };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.subscription) {
        store.stripeSubscriptionId = String(obj.subscription);

        if (isConfigured()) {
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(env.stripe.secretKey);
          try {
            const subscription = await stripe.subscriptions.retrieve(String(obj.subscription));
            await activateStoreSubscription(store, subscription);
          } catch {
            await activateStoreSubscription(store, { id: String(obj.subscription) });
          }
        } else {
          await activateStoreSubscription(store, { id: String(obj.subscription) });
        }
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      store.stripeSubscriptionId = obj.id;
      applyPeriodDates(store, obj);

      // Keep local Auto Subscription preference as source of truth when set.
      // Still accept Stripe cancel_at_period_end when the store has no explicit false
      // (e.g. customer cancelled via Billing Portal → mirror as autoRenew OFF).
      if (typeof obj.cancel_at_period_end === 'boolean') {
        if (store.autoRenew === false) {
          // User opted out — re-assert Stripe if portal/webhook drifted
          if (!obj.cancel_at_period_end || !obj.pause_collection) {
            await ensureStripeMatchesAutoRenew(store, obj);
          }
        } else {
          store.autoRenew = !obj.cancel_at_period_end;
          store.autoRenewUpdatedAt = store.autoRenewUpdatedAt || new Date();
        }
      }

      const mapped = mapStripeSubscriptionStatus(obj.status);

      if (mapped === SUBSCRIPTION_STATUS.ACTIVE) {
        await activateStoreSubscription(store, obj);
      } else if (mapped === SUBSCRIPTION_STATUS.PAUSED) {
        store.subscriptionStatus = SUBSCRIPTION_STATUS.PAUSED;
        store.assistantEnabled = false;
      } else if (mapped === SUBSCRIPTION_STATUS.CANCELLED) {
        store.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
        store.assistantEnabled = false;
        store.stripeSubscriptionId = null;
      } else if (mapped === SUBSCRIPTION_STATUS.PAST_DUE) {
        store.subscriptionStatus = SUBSCRIPTION_STATUS.PAST_DUE;
        if (store.autoRenew === false && isConfigured()) {
          try {
            const Stripe = (await import('stripe')).default;
            const stripe = new Stripe(env.stripe.secretKey);
            await ensureStripeMatchesAutoRenew(store, obj);
            await stopAutomaticCollectionOnOpenInvoices(stripe, store);
          } catch (error) {
            console.warn('[billing] past_due autoRenew halt failed:', error.message);
          }
        }
      } else if (mapped) {
        store.subscriptionStatus = mapped;
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      store.paymentRetryCount = 0;
      store.lastPaymentFailedAt = null;
      if (obj.subscription) {
        store.stripeSubscriptionId = String(obj.subscription);
      }
      if (store.subscriptionStatus !== SUBSCRIPTION_STATUS.ACTIVE) {
        await activateStoreSubscription(store, {
          id: store.stripeSubscriptionId,
          current_period_end: obj.lines?.data?.[0]?.period?.end,
          current_period_start: obj.lines?.data?.[0]?.period?.start,
        });
      } else if (obj.lines?.data?.[0]?.period?.end) {
        store.subscriptionEndDate = new Date(obj.lines.data[0].period.end * 1000);
        store.nextBillingDate = store.subscriptionEndDate;
      }
      break;
    }

    case 'invoice.payment_failed': {
      store.subscriptionStatus = SUBSCRIPTION_STATUS.PAST_DUE;
      store.lastPaymentFailedAt = new Date();
      store.paymentRetryCount = (store.paymentRetryCount || 0) + 1;

      const autoRenewEnabled = store.autoRenew !== false;

      // Auto Subscription OFF → stop Stripe from retrying this invoice automatically
      if (!autoRenewEnabled && isConfigured()) {
        try {
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(env.stripe.secretKey);
          if (obj?.id) {
            await stripe.invoices.update(obj.id, { auto_advance: false }).catch(() => {});
          }
          await ensureStripeMatchesAutoRenew(store);
          await stopAutomaticCollectionOnOpenInvoices(stripe, store);
        } catch (error) {
          console.warn('[billing] Failed to halt auto-retries after payment_failed:', error.message);
        }
      }

      const email = await getStoreOwnerEmail(store);
      if (email) {
        await sendPaymentFailedEmail(email, {
          storeName: store.name,
          // Only promise automatic retries when Auto Subscription is still ON
          retryAttempted: autoRenewEnabled && store.paymentRetryCount <= MAX_PAYMENT_RETRIES,
        });
      }

      // After 1–2 automatic retries fail, pause service (only relevant when auto-renew is ON)
      if (autoRenewEnabled && store.paymentRetryCount >= MAX_PAYMENT_RETRIES) {
        await pauseStoreForFailedPayment(store);
      }
      break;
    }

    case 'customer.subscription.deleted':
      store.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
      store.assistantEnabled = false;
      store.stripeSubscriptionId = null;
      break;

    default:
      await ProcessedStripeEvent.create({ eventId: event.id, type: event.type });
      return { handled: false };
  }

  await store.save();
  await ProcessedStripeEvent.create({ eventId: event.id, type: event.type });

  return { handled: true, storeId: store._id };
};

/**
 * Sync local subscription status from Stripe when opening Billing.
 * Ensures Payment Failed UI appears even if a webhook was missed.
 * Does NOT treat "renewal date is today" alone as a failure — only Stripe
 * payment state (past_due / unpaid open invoice) does.
 */
async function syncStoreBillingStatusFromStripe(store) {
  if (!store || !isConfigured()) return store;
  if (!store.stripeSubscriptionId && !store.stripeCustomerId) return store;

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.stripe.secretKey);

    let stripeStatus = null;
    let subscription = null;

    if (store.stripeSubscriptionId) {
      subscription = await stripe.subscriptions.retrieve(store.stripeSubscriptionId);
      stripeStatus = subscription.status;
      applyPeriodDates(store, subscription);
      // Keep Stripe collection aligned with Auto Subscription toggle
      subscription = (await ensureStripeMatchesAutoRenew(store, subscription)) || subscription;
      stripeStatus = subscription.status || stripeStatus;
    }

    const mapped = mapStripeSubscriptionStatus(stripeStatus);
    const openInvoice = await findOpenRenewalInvoice(stripe, store);
    const hasUnpaidRenewal =
      Boolean(openInvoice) &&
      Number(openInvoice.amount_due || 0) > 0 &&
      ['open', 'uncollectible'].includes(openInvoice.status);

    // Auto Subscription OFF: never leave open invoices on auto-retry
    if (store.autoRenew === false && hasUnpaidRenewal) {
      await stopAutomaticCollectionOnOpenInvoices(stripe, store);
    }

    let dirty = false;

    if (mapped === SUBSCRIPTION_STATUS.ACTIVE && !hasUnpaidRenewal) {
      if (store.subscriptionStatus !== SUBSCRIPTION_STATUS.ACTIVE) {
        await activateStoreSubscription(store, subscription);
        dirty = true;
      }
    } else if (
      mapped === SUBSCRIPTION_STATUS.PAST_DUE ||
      stripeStatus === 'unpaid' ||
      hasUnpaidRenewal
    ) {
      if (store.subscriptionStatus !== SUBSCRIPTION_STATUS.PAST_DUE) {
        store.subscriptionStatus = SUBSCRIPTION_STATUS.PAST_DUE;
        store.lastPaymentFailedAt = store.lastPaymentFailedAt || new Date();
        dirty = true;
      }
    } else if (mapped === SUBSCRIPTION_STATUS.PAUSED) {
      if (store.subscriptionStatus !== SUBSCRIPTION_STATUS.PAUSED) {
        store.subscriptionStatus = SUBSCRIPTION_STATUS.PAUSED;
        store.assistantEnabled = false;
        dirty = true;
      }
    } else if (mapped === SUBSCRIPTION_STATUS.EXPIRED) {
      if (store.subscriptionStatus !== SUBSCRIPTION_STATUS.EXPIRED) {
        store.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
        store.assistantEnabled = false;
        dirty = true;
      }
    }

    if (dirty) {
      await store.save();
    }
  } catch (error) {
    console.warn('[billing] Stripe status sync skipped:', error.message);
  }

  return store;
}

export const getBillingInfo = async (store = null) => {
  if (store) {
    await syncStoreBillingStatusFromStripe(store);
  }

  const paymentMethod = await resolvePaymentMethodDisplay(store);
  const status = store?.subscriptionStatus || null;
  const paymentFailed =
    status === SUBSCRIPTION_STATUS.PAST_DUE || status === SUBSCRIPTION_STATUS.PAUSED;
  const openInvoice = paymentFailed ? await resolveOpenInvoiceSummary(store) : null;
  const canRetryPayment =
    paymentFailed && Boolean(store?.stripeSubscriptionId || store?.stripeCustomerId);

  return {
    monthlyPrice: MONTHLY_PRICE_CENTS / 100,
    currency: 'USD',
    configured: isConfigured(),
    plan: store?.subscriptionPlan || 'pro',
    subscriptionStatus: status,
    subscriptionStartDate: store?.subscriptionStartDate || null,
    subscriptionEndDate: store?.subscriptionEndDate || null,
    nextBillingDate: store?.nextBillingDate || null,
    paymentRetryCount: store?.paymentRetryCount || 0,
    lastPaymentFailedAt: store?.lastPaymentFailedAt || null,
    /** Renewal recovery — driven by payment failure status, not renewal date alone */
    paymentFailed,
    canRetryPayment,
    openInvoice,
    paymentFailureMessage: paymentFailed
      ? openInvoice?.failureMessage ||
        'We were unable to renew your subscription because your recent payment could not be processed. Please retry your payment to continue using VapePass without interruption.'
      : null,
    /** Auto Subscription — default ON */
    autoRenew: store?.autoRenew !== false,
    autoRenewUpdatedAt: store?.autoRenewUpdatedAt || null,
    hasStripeSubscription: Boolean(store?.stripeSubscriptionId),
    canManageAutoRenew:
      Boolean(store?.stripeSubscriptionId) &&
      ['active', 'past_due'].includes(String(status || '')),
    /** Customer payment method (card brand / type) — never "Stripe" */
    billingProvider: paymentMethod.label,
    paymentMethodBrand: paymentMethod.brand,
    paymentMethodLast4: paymentMethod.last4,
    paymentMethodType: paymentMethod.type,
  };
};

const CARD_BRAND_LABELS = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  elo: 'Elo',
  hipercard: 'Hipercard',
};

const PAYMENT_TYPE_LABELS = {
  card: 'Card',
  link: 'Link',
  paypal: 'PayPal',
  cashapp: 'Cash App',
  affirm: 'Affirm',
  afterpay_clearpay: 'Afterpay',
  klarna: 'Klarna',
  us_bank_account: 'Bank Account',
  sepa_debit: 'SEPA Debit',
  ideal: 'iDEAL',
  bancontact: 'Bancontact',
  giropay: 'Giropay',
  eps: 'EPS',
  p24: 'Przelewy24',
  alipay: 'Alipay',
  wechat_pay: 'WeChat Pay',
};

function formatCardBrand(brand) {
  if (!brand) return null;
  const key = String(brand).toLowerCase().trim();
  if (CARD_BRAND_LABELS[key]) return CARD_BRAND_LABELS[key];
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPaymentType(type) {
  if (!type) return null;
  const key = String(type).toLowerCase().trim();
  if (PAYMENT_TYPE_LABELS[key]) return PAYMENT_TYPE_LABELS[key];
  return formatCardBrand(key);
}

function summarizePaymentMethod(paymentMethod) {
  if (!paymentMethod || typeof paymentMethod !== 'object') {
    return { label: 'Not Available', brand: null, last4: null, type: null };
  }

  const type = paymentMethod.type || null;

  if (type === 'card' && paymentMethod.card) {
    const brand = formatCardBrand(paymentMethod.card.brand);
    const last4 = paymentMethod.card.last4 || null;
    return {
      label: brand || 'Card',
      brand: brand || paymentMethod.card.brand || null,
      last4,
      type: 'card',
    };
  }

  if (type === 'link') {
    return { label: 'Link', brand: 'Link', last4: null, type: 'link' };
  }

  if (type === 'us_bank_account' && paymentMethod.us_bank_account) {
    const bank = paymentMethod.us_bank_account.bank_name;
    const last4 = paymentMethod.us_bank_account.last4 || null;
    return {
      label: bank ? formatCardBrand(bank) : 'Bank Account',
      brand: bank || null,
      last4,
      type,
    };
  }

  const label = formatPaymentType(type) || 'Not Available';
  return { label, brand: label === 'Not Available' ? null : label, last4: null, type };
}

/**
 * Resolve the customer's default payment method from Stripe (subscription or customer).
 * Used only for display — does not alter billing/checkout behavior.
 */
async function resolvePaymentMethodDisplay(store) {
  const empty = { label: 'Not Available', brand: null, last4: null, type: null };

  if (!store || !isConfigured()) return empty;
  if (!store.stripeCustomerId && !store.stripeSubscriptionId) return empty;

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.stripe.secretKey);

    let paymentMethod = null;

    if (store.stripeSubscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(store.stripeSubscriptionId, {
        expand: ['default_payment_method'],
      });
      const pm = subscription.default_payment_method;
      if (pm && typeof pm === 'object') {
        paymentMethod = pm;
      } else if (typeof pm === 'string') {
        paymentMethod = await stripe.paymentMethods.retrieve(pm);
      }
    }

    if (!paymentMethod && store.stripeCustomerId) {
      const customer = await stripe.customers.retrieve(store.stripeCustomerId, {
        expand: ['invoice_settings.default_payment_method'],
      });

      if (customer && !customer.deleted) {
        const defaultPm = customer.invoice_settings?.default_payment_method;
        if (defaultPm && typeof defaultPm === 'object') {
          paymentMethod = defaultPm;
        } else if (typeof defaultPm === 'string') {
          paymentMethod = await stripe.paymentMethods.retrieve(defaultPm);
        }

        if (!paymentMethod) {
          const methods = await stripe.paymentMethods.list({
            customer: store.stripeCustomerId,
            type: 'card',
            limit: 1,
          });
          paymentMethod = methods.data?.[0] || null;
        }
      }
    }

    return summarizePaymentMethod(paymentMethod);
  } catch (error) {
    console.warn('[billing] Unable to resolve payment method:', error.message);
    return { label: 'Unknown', brand: null, last4: null, type: null };
  }
}
