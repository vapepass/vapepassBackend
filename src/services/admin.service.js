import Store from '../models/Store.js';
import Customer from '../models/Customer.js';
import Activity from '../models/Activity.js';
import User from '../models/User.js';
import { SUBSCRIPTION_STATUS } from '../utils/constants.js';

export const getAdminOverview = async () => {
  const [totalStores, totalCustomers, totalOwners, statusAgg, recentActivity] =
    await Promise.all([
      Store.countDocuments(),
      Customer.countDocuments(),
      User.countDocuments({ role: 'store_owner' }),
      Store.aggregate([
        { $group: { _id: '$subscriptionStatus', count: { $sum: 1 } } },
      ]),
      Activity.find()
        .sort({ createdAt: -1 })
        .limit(8)
        .populate('storeId', 'name'),
    ]);

  const byStatus = Object.values(SUBSCRIPTION_STATUS).reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});

  for (const row of statusAgg) {
    if (row._id) byStatus[row._id] = row.count;
  }

  return {
    totalStores,
    totalCustomers,
    totalOwners,
    subscriptionCounts: byStatus,
    recentActivity: recentActivity.map((a) => ({
      id: a._id,
      type: a.type,
      customerName: a.customerName,
      detail: a.detail,
      storeName: a.storeId?.name || 'Unknown store',
      createdAt: a.createdAt,
    })),
  };
};

export const getAdminBusinesses = async ({ page = 1, limit = 20, status } = {}) => {
  const filter = {};
  if (status && status !== 'all') filter.subscriptionStatus = status;

  const skip = (page - 1) * limit;

  const [stores, total] = await Promise.all([
    Store.find(filter)
      .populate('createdBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Store.countDocuments(filter),
  ]);

  const storeIds = stores.map((s) => s._id);
  const customerCounts = await Customer.aggregate([
    { $match: { storeId: { $in: storeIds } } },
    { $group: { _id: '$storeId', count: { $sum: 1 } } },
  ]);

  const countMap = Object.fromEntries(
    customerCounts.map((c) => [String(c._id), c.count])
  );

  const businesses = stores.map((store) => ({
    id: store._id,
    name: store.name,
    brandColor: store.brandColor,
    stampGoal: store.stampGoal,
    rewardDescription: store.rewardDescription,
    subscriptionStatus: store.subscriptionStatus,
    customerCount: countMap[String(store._id)] || 0,
    owner: store.createdBy
      ? {
          name: `${store.createdBy.firstName} ${store.createdBy.lastName}`,
          email: store.createdBy.email,
        }
      : null,
    createdAt: store.createdAt,
  }));

  return { businesses, total, page, pages: Math.ceil(total / limit) };
};

export const getAdminPrograms = async () => {
  const stores = await Store.find()
    .select('name brandColor stampGoal rewardDescription subscriptionStatus createdAt')
    .sort({ name: 1 })
    .lean();

  const storeIds = stores.map((s) => s._id);
  const customerCounts = await Customer.aggregate([
    { $match: { storeId: { $in: storeIds } } },
    { $group: { _id: '$storeId', count: { $sum: 1 } } },
  ]);

  const countMap = Object.fromEntries(
    customerCounts.map((c) => [String(c._id), c.count])
  );

  return stores.map((store) => ({
    id: store._id,
    storeName: store.name,
    brandColor: store.brandColor,
    stampGoal: store.stampGoal,
    rewardDescription: store.rewardDescription,
    subscriptionStatus: store.subscriptionStatus,
    customerCount: countMap[String(store._id)] || 0,
    createdAt: store.createdAt,
  }));
};

export const updateBusinessSubscription = async (storeId, subscriptionStatus) => {
  const store = await Store.findByIdAndUpdate(
    storeId,
    { subscriptionStatus },
    { new: true, runValidators: true }
  );

  return store;
};
