import { env } from '../config/env.js';

/** Keep cookie lifetime aligned with JWT_REFRESH_EXPIRES (default 30d). */
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: env.nodeEnv === 'production' ? 'strict' : 'lax',
  maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  path: '/api/v1/auth',
};

export const setRefreshTokenCookie = (res, refreshToken) => {
  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);
};

export const clearRefreshTokenCookie = (res) => {
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: env.nodeEnv === 'production' ? 'strict' : 'lax',
    path: '/api/v1/auth',
  });
};
