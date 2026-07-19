/**
 * In-memory registry of active inventory scrape jobs (per store).
 * Used for Force Stop — cooperative abort via AbortController.
 */

const activeJobs = new Map();

export function registerScrapeJob(storeId, controller = new AbortController()) {
  const key = String(storeId);
  const existing = activeJobs.get(key);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }
  activeJobs.set(key, controller);
  return controller;
}

export function getScrapeJob(storeId) {
  return activeJobs.get(String(storeId)) || null;
}

export function abortScrapeJob(storeId) {
  const key = String(storeId);
  const controller = activeJobs.get(key);
  if (!controller) return false;
  if (!controller.signal.aborted) {
    controller.abort();
  }
  return true;
}

export function clearScrapeJob(storeId, controller) {
  const key = String(storeId);
  const current = activeJobs.get(key);
  if (!controller || current === controller) {
    activeJobs.delete(key);
  }
}

export function isScrapeJobActive(storeId) {
  const controller = activeJobs.get(String(storeId));
  return Boolean(controller && !controller.signal.aborted);
}

export class ScrapeAbortedError extends Error {
  constructor(message = 'Inventory scrape stopped') {
    super(message);
    this.name = 'ScrapeAbortedError';
    this.code = 'SCRAPE_ABORTED';
  }
}

export function assertScrapeNotAborted(signal) {
  if (signal?.aborted) {
    throw new ScrapeAbortedError();
  }
}
