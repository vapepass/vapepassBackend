import { env } from '../config/env.js';
import {
  expireOverdueSubscriptions,
  sendUpcomingRenewalReminders,
} from '../services/subscriptionLifecycle.service.js';

let started = false;

/**
 * Optional in-process daily cron for subscription reminders / expiry.
 */
export function startSubscriptionCron() {
  if (started || !env.enableInternalCron) {
    return;
  }

  started = true;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const run = async () => {
    console.log('[cron] Subscription lifecycle job starting');
    try {
      const reminders = await sendUpcomingRenewalReminders();
      const expired = await expireOverdueSubscriptions();
      console.log(
        `[cron] Renewal reminders: ${reminders.checked}, expired: ${expired.updated}`
      );
    } catch (error) {
      console.error('[cron] Subscription lifecycle failed:', error.message);
    }
  };

  setTimeout(run, 45_000);
  setInterval(run, DAY_MS);
  console.log('[cron] Internal subscription cron enabled (every 24 hours)');
}
