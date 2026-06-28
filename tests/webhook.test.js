import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Store from '../src/models/Store.js';
import ProcessedStripeEvent from '../src/models/ProcessedStripeEvent.js';
import { handleWebhookEvent } from '../src/services/stripe.service.js';
import { SUBSCRIPTION_STATUS } from '../src/utils/constants.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './helpers/setup.js';

describe('Stripe webhook idempotency', () => {
  before(async () => {
    await connectTestDB();
  });

  after(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearCollections();
  });

  test('skips duplicate webhook events', async () => {
    const store = await Store.create({
      name: 'Test Store',
      createdBy: new mongoose.Types.ObjectId(),
      stripeCustomerId: 'cus_test123',
      subscriptionStatus: SUBSCRIPTION_STATUS.TRIAL,
    });

    const event = {
      id: 'evt_test_duplicate',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test123',
          customer: 'cus_test123',
          status: 'active',
          metadata: { storeId: String(store._id) },
        },
      },
    };

    const first = await handleWebhookEvent(event);
    const second = await handleWebhookEvent(event);

    assert.equal(first.handled, true);
    assert.equal(second.duplicate, true);

    const processed = await ProcessedStripeEvent.countDocuments({ eventId: 'evt_test_duplicate' });
    assert.equal(processed, 1);

    const updated = await Store.findById(store._id);
    assert.equal(updated.subscriptionStatus, SUBSCRIPTION_STATUS.ACTIVE);
  });

  test('maps payment_failed to past_due', async () => {
    const store = await Store.create({
      name: 'Billing Store',
      createdBy: new mongoose.Types.ObjectId(),
      stripeCustomerId: 'cus_billing',
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
    });

    await handleWebhookEvent({
      id: 'evt_payment_failed',
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_billing',
          metadata: { storeId: String(store._id) },
        },
      },
    });

    const updated = await Store.findById(store._id);
    assert.equal(updated.subscriptionStatus, SUBSCRIPTION_STATUS.PAST_DUE);
  });
});
