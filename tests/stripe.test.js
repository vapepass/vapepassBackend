import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapStripeSubscriptionStatus } from '../src/utils/stripeStatus.js';
import { SUBSCRIPTION_STATUS } from '../src/utils/constants.js';
import { hashToken } from '../src/utils/token.js';

describe('Stripe status mapping', () => {
  test('maps active and trialing to active', () => {
    assert.equal(mapStripeSubscriptionStatus('active'), SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(mapStripeSubscriptionStatus('trialing'), SUBSCRIPTION_STATUS.ACTIVE);
  });

  test('maps past_due and unpaid to past_due', () => {
    assert.equal(mapStripeSubscriptionStatus('past_due'), SUBSCRIPTION_STATUS.PAST_DUE);
    assert.equal(mapStripeSubscriptionStatus('unpaid'), SUBSCRIPTION_STATUS.PAST_DUE);
  });

  test('maps canceled to expired', () => {
    assert.equal(mapStripeSubscriptionStatus('canceled'), SUBSCRIPTION_STATUS.EXPIRED);
  });
});

describe('Token utilities', () => {
  test('hashToken is deterministic', () => {
    const a = hashToken('abc123');
    const b = hashToken('abc123');
    assert.equal(a, b);
    assert.notEqual(a, hashToken('different'));
  });
});
