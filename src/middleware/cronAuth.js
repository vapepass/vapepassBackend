import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';

/**
 * Protects cron endpoints with CRON_SECRET (Bearer or x-cron-secret header).
 */
export function authenticateCron(req, _res, next) {
  const headerSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const bearerSecret = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  const provided = headerSecret || bearerSecret;

  if (!env.cronSecret) {
    return next(new ApiError(503, 'Cron endpoint is not configured'));
  }

  if (!provided || provided !== env.cronSecret) {
    return next(new ApiError(401, 'Invalid cron credentials'));
  }

  return next();
}
