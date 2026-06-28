import Store from '../models/Store.js';
import { ApiError } from '../utils/constants.js';
import { asyncHandler } from './asyncHandler.js';

/**
 * Loads the authenticated user's store onto req.store.
 * Must be used after authenticateUser.
 */
export const resolveStore = asyncHandler(async (req, res, next) => {
  if (!req.user?.storeId) {
    throw new ApiError(403, 'No store associated with this account');
  }

  const store = await Store.findById(req.user.storeId);

  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  req.store = store;
  next();
});
