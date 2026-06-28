import Customer from '../models/Customer.js';
import Activity from '../models/Activity.js';
import { ACTIVITY_TYPES } from '../utils/constants.js';

function monthBuckets(monthsBack = 6) {
  const now = new Date();
  const buckets = [];

  for (let i = monthsBack - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
    buckets.push({
      label: start.toLocaleDateString('en-CA', { month: 'short' }),
      start,
      end,
    });
  }

  return buckets;
}

export const getStoreDashboardAnalytics = async (storeId) => {
  const buckets = monthBuckets(6);
  const earliest = buckets[0].start;

  const activities = await Activity.find({
    storeId,
    createdAt: { $gte: earliest },
  }).select('type createdAt');

  const growth = [];
  const loyalty = [];

  for (const bucket of buckets) {
    const totalCustomers = await Customer.countDocuments({
      storeId,
      createdAt: { $lte: bucket.end },
    });

    const inMonth = activities.filter(
      (a) => a.createdAt >= bucket.start && a.createdAt <= bucket.end
    );

    const stamps = inMonth.filter((a) => a.type === ACTIVITY_TYPES.STAMP_ADDED).length;
    const rewards = inMonth.filter(
      (a) =>
        a.type === ACTIVITY_TYPES.REWARD_EARNED ||
        a.type === ACTIVITY_TYPES.REWARD_REDEEMED
    ).length;

    growth.push({ month: bucket.label, customers: totalCustomers });
    loyalty.push({ month: bucket.label, stamps, rewards });
  }

  return { growth, loyalty };
};
