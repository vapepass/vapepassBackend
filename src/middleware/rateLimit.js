/**
 * Lightweight in-memory rate limiter (no external dependency).
 * Suitable for single-instance deployments. Replace with Redis-backed
 * limiting if you scale horizontally.
 */

const buckets = new Map();

function pruneExpired(now) {
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

/**
 * @param {{ windowMs?: number, max?: number, keyGenerator?: (req) => string }} options
 */
export function rateLimit({
  windowMs = 15 * 60 * 1000,
  max = 5,
  keyGenerator = (req) => {
    const userPart = req.user?._id ? `user:${req.user._id}` : 'anon';
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    return `${userPart}:${ip}`;
  },
} = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 5000) pruneExpired(now);

    const key = keyGenerator(req);
    let entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return res.status(429).json({
        success: false,
        message: 'Too many setup requests. Please try again later.',
      });
    }

    return next();
  };
}
