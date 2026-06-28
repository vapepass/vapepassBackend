import Customer from '../models/Customer.js';
import Store from '../models/Store.js';
import { ApiError, ACTIVITY_TYPES, CUSTOMER_STATUS } from '../utils/constants.js';
import { logActivity } from './activity.service.js';
import { validateVerificationCode } from './verification.service.js';
import * as passkitService from './passkit.service.js';

export const joinCustomer = async ({ storeId, code, fullName, phone, email }) => {
  const store = await Store.findById(storeId);
  if (!store) throw new ApiError(404, 'Store not found');

  const verification = await validateVerificationCode(storeId, code);

  const passIdentifier = passkitService.generatePassIdentifier();

  const customer = await Customer.create({
    storeId,
    fullName: fullName.trim(),
    phone: phone.trim(),
    email: email?.trim() || null,
    stamps: 0,
    stampGoal: store.stampGoal,
    passIdentifier,
    verificationCodeId: verification._id,
  });

  verification.usedAt = new Date();
  verification.customerId = customer._id;
  await verification.save();

  const walletUrls = await passkitService.issuePass(store, customer);

  customer.passKitMemberId = walletUrls.memberId;
  customer.appleWalletUrl = walletUrls.appleWalletUrl;
  customer.googleWalletUrl = walletUrls.googleWalletUrl;
  await customer.save();

  await logActivity({
    storeId,
    type: ACTIVITY_TYPES.CUSTOMER_JOINED,
    customerId: customer._id,
    customerName: customer.fullName,
    detail: 'Joined loyalty program',
    metadata: { phone: customer.phone },
  });

  return {
    customer,
    store: {
      name: store.name,
      brandColor: store.brandColor,
      rewardDescription: store.rewardDescription,
      stampGoal: store.stampGoal,
      logo: store.logo,
    },
    wallet: walletUrls,
  };
};

export const getCustomers = async (storeId, { search, page = 1, limit = 20 } = {}) => {
  const filter = { storeId };

  if (search) {
    const regex = new RegExp(search.trim(), 'i');
    filter.$or = [{ fullName: regex }, { phone: regex }, { email: regex }];
  }

  const skip = (page - 1) * limit;

  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);

  return { customers, total, page, pages: Math.ceil(total / limit) };
};

export const getCustomerById = async (storeId, customerId) => {
  const customer = await Customer.findOne({ _id: customerId, storeId });
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
};

export const lookupCustomerByPassId = async (storeId, passIdentifier) => {
  const raw = String(passIdentifier).trim();
  const id = raw.startsWith('vapepass:') ? raw.replace('vapepass:', '') : raw;

  const customer = await Customer.findOne({ storeId, passIdentifier: id });
  if (!customer) throw new ApiError(404, 'Customer not found for this QR code');
  return customer;
};

export const addStamp = async (storeId, customerId, performedBy) => {
  const customer = await Customer.findOne({ _id: customerId, storeId });
  if (!customer) throw new ApiError(404, 'Customer not found');

  if (customer.stamps >= customer.stampGoal) {
    throw new ApiError(
      400,
      'Customer has reached their reward. Redeem the reward before adding more stamps.'
    );
  }

  const store = await Store.findById(storeId);
  customer.stamps += 1;

  const stampsRemaining = customer.stampGoal - customer.stamps;

  if (customer.stamps >= customer.stampGoal) {
    customer.status = CUSTOMER_STATUS.REWARDED;
    await passkitService.notifyRewardReady(store, customer);
    await logActivity({
      storeId,
      type: ACTIVITY_TYPES.REWARD_EARNED,
      customerId: customer._id,
      customerName: customer.fullName,
      detail: `Reward earned — ${store?.rewardDescription || 'Free reward'}`,
      performedBy,
    });
  } else {
    if (stampsRemaining === 2) {
      await passkitService.notifyTwoStampsAway(store, customer);
    }
    await logActivity({
      storeId,
      type: ACTIVITY_TYPES.STAMP_ADDED,
      customerId: customer._id,
      customerName: customer.fullName,
      detail: `Stamp added — ${customer.stamps}/${customer.stampGoal}`,
      performedBy,
    });
  }

  await customer.save();
  await passkitService.updatePassStamps(store, customer);

  return customer;
};

export const redeemReward = async (storeId, customerId, performedBy) => {
  const customer = await Customer.findOne({ _id: customerId, storeId });
  if (!customer) throw new ApiError(404, 'Customer not found');

  if (customer.stamps < customer.stampGoal) {
    throw new ApiError(400, 'Customer has not earned a reward yet');
  }

  const store = await Store.findById(storeId);

  customer.stamps = 0;
  customer.status = CUSTOMER_STATUS.ACTIVE;
  await customer.save();

  await passkitService.updatePassStamps(store, customer);

  await logActivity({
    storeId,
    type: ACTIVITY_TYPES.REWARD_REDEEMED,
    customerId: customer._id,
    customerName: customer.fullName,
    detail: 'Reward redeemed — stamp count reset',
    performedBy,
  });

  return customer;
};

export const getCustomerStats = async (storeId) => {
  const [total, active, rewarded] = await Promise.all([
    Customer.countDocuments({ storeId }),
    Customer.countDocuments({ storeId, status: CUSTOMER_STATUS.ACTIVE }),
    Customer.countDocuments({ storeId, status: CUSTOMER_STATUS.REWARDED }),
  ]);

  return { total, active, rewarded };
};
