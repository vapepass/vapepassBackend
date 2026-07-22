import Store from '../models/Store.js';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { sendRenewalReminderEmail } from './email.service.js';

const MONTHLY_PRICE = 99;
const REMINDER_WINDOW_START_DAYS = 2; // ~day 28 of a 30-day cycle
const REMINDER_WINDOW_END_DAYS = 4; // ~day 26–28

/**
 * Send renewal reminders for subscriptions renewing in ~2–4 days (day 27–28 window).
 */
export async function sendUpcomingRenewalReminders() {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() + REMINDER_WINDOW_START_DAYS);
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + REMINDER_WINDOW_END_DAYS);

  const stores = await Store.find({
    subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
    autoRenew: { $ne: false },
    nextBillingDate: { $gte: windowStart, $lte: windowEnd },
    $or: [
      { renewalReminderSentAt: null },
      {
        renewalReminderSentAt: {
          $lt: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
        },
      },
    ],
  });

  const results = [];

  for (const store of stores) {
    const owner = await User.findById(store.createdBy).select('email');
    if (!owner?.email) {
      results.push({ storeId: store._id, sent: false, reason: 'no_owner_email' });
      continue;
    }

    const emailResult = await sendRenewalReminderEmail(owner.email, {
      storeName: store.name,
      renewalDate: store.nextBillingDate,
      amount: MONTHLY_PRICE,
      currency: 'USD',
    });

    store.renewalReminderSentAt = new Date();
    await store.save();

    results.push({
      storeId: store._id,
      sent: Boolean(emailResult.sent || emailResult.devFallback),
    });
  }

  return {
    checked: stores.length,
    results,
    clientUrl: env.clientUrl,
  };
}

/**
 * Mark subscriptions past end date without renewal as expired and disable chatbot.
 */
export async function expireOverdueSubscriptions() {
  const now = new Date();
  const stores = await Store.find({
    subscriptionStatus: {
      $in: [SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.CANCELLED],
    },
    subscriptionEndDate: { $lt: now },
  });

  let updated = 0;
  for (const store of stores) {
    store.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
    store.assistantEnabled = false;
    await store.save();
    updated += 1;
  }

  return { updated };
}
