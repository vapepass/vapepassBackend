import Activity from '../models/Activity.js';

export const logActivity = async ({
  storeId,
  type,
  customerName,
  detail,
  customerId = null,
  performedBy = null,
  metadata = {},
}) => {
  return Activity.create({
    storeId,
    type,
    customerName,
    detail,
    customerId,
    performedBy,
    metadata,
  });
};

export const getStoreActivity = async (storeId, { type, limit = 50, page = 1 } = {}) => {
  const filter = { storeId };
  if (type && type !== 'all') filter.type = type;

  const skip = (page - 1) * limit;

  const [activities, total] = await Promise.all([
    Activity.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Activity.countDocuments(filter),
  ]);

  return { activities, total, page, pages: Math.ceil(total / limit) };
};
