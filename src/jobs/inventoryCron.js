import { env } from '../config/env.js';
import { syncAllStoreInventories } from '../services/inventory.service.js';

let started = false;

/**
 * Optional in-process daily cron for self-hosted deployments.
 * Vercel / external schedulers should hit POST /api/v1/cron/sync-inventory instead.
 */
export function startInventoryCron() {
  if (started || !env.enableInternalCron) {
    return;
  }

  started = true;

  // Run every 24 hours
  const DAY_MS = 24 * 60 * 60 * 1000;

  const run = async () => {
    console.log('[cron] Internal daily inventory sync starting');
    try {
      await syncAllStoreInventories();
    } catch (error) {
      console.error('[cron] Internal inventory sync failed:', error.message);
    }
  };

  // First run shortly after boot, then every 24h
  setTimeout(run, 30_000);
  setInterval(run, DAY_MS);

  console.log('[cron] Internal inventory cron enabled (every 24 hours)');
}
