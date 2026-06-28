import Store from '../models/Store.js';
import { ApiError, SUBSCRIPTION_STATUS } from '../utils/constants.js';

export const getPublicStore = async (storeId) => {
  const store = await Store.findById(storeId).select(
    'name logo brandColor rewardDescription stampGoal subscriptionStatus'
  );

  if (!store) throw new ApiError(404, 'Store not found');

  if ([SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.PAUSED].includes(store.subscriptionStatus)) {
    throw new ApiError(403, 'This loyalty program is not currently accepting new members');
  }

  return store;
};
