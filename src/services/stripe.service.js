import { env } from '../config/env.js';
import Store from '../models/Store.js';
import ProcessedStripeEvent from '../models/ProcessedStripeEvent.js';
import { ApiError, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { mapStripeSubscriptionStatus } from '../utils/stripeStatus.js';

const MONTHLY_PRICE_CENTS = 9900; // $99/month per project doc

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

/**
 * Stripe billing service.
 * Configure STRIPE_SECRET_KEY and STRIPE_PRICE_ID to enable checkout.
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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: env.stripe.priceId, quantity: 1 }],
    success_url: `${env.clientUrl}/settings?billing=success`,
    cancel_url: `${env.clientUrl}/settings?billing=cancelled`,
    metadata: { storeId: String(store._id) },
    subscription_data: {
      metadata: { storeId: String(store._id) },
    },
  });

  return { url: session.url, sessionId: session.id };
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
    return_url: `${env.clientUrl}/settings`,
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
    case 'checkout.session.completed':
      if (obj.subscription) {
        store.stripeSubscriptionId = String(obj.subscription);
        store.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
      }
      break;

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      store.stripeSubscriptionId = obj.id;
      const mapped = mapStripeSubscriptionStatus(obj.status);
      if (mapped) store.subscriptionStatus = mapped;
      break;
    }

    case 'invoice.payment_failed':
      store.subscriptionStatus = SUBSCRIPTION_STATUS.PAST_DUE;
      break;

    case 'customer.subscription.deleted':
      store.subscriptionStatus = SUBSCRIPTION_STATUS.CANCELLED;
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

export const getBillingInfo = () => ({
  monthlyPrice: MONTHLY_PRICE_CENTS / 100,
  currency: 'USD',
  configured: isConfigured(),
});
