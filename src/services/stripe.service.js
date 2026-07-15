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

  if (stripeSubscription) {
    store.stripeSubscriptionId = stripeSubscription.id || store.stripeSubscriptionId;
    applyPeriodDates(store, stripeSubscription);
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

      const email = await getStoreOwnerEmail(store);
      if (email) {
        await sendPaymentFailedEmail(email, {
          storeName: store.name,
          retryAttempted: store.paymentRetryCount <= MAX_PAYMENT_RETRIES,
        });
      }

      // After 1–2 automatic retries fail, pause service
      if (store.paymentRetryCount >= MAX_PAYMENT_RETRIES) {
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

export const getBillingInfo = (store = null) => ({
  monthlyPrice: MONTHLY_PRICE_CENTS / 100,
  currency: 'USD',
  configured: isConfigured(),
  plan: store?.subscriptionPlan || 'pro',
  subscriptionStatus: store?.subscriptionStatus || null,
  subscriptionStartDate: store?.subscriptionStartDate || null,
  subscriptionEndDate: store?.subscriptionEndDate || null,
  nextBillingDate: store?.nextBillingDate || null,
  paymentRetryCount: store?.paymentRetryCount || 0,
});
