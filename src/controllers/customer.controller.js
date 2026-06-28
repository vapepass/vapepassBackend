import Customer from '../models/Customer.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ApiError } from '../utils/constants.js';
import * as customerService from '../services/customer.service.js';
import * as publicService from '../services/public.service.js';

export const joinCustomer = asyncHandler(async (req, res) => {
  const result = await customerService.joinCustomer({
    storeId: req.params.storeId,
    ...req.body,
  });

  return sendSuccess(res, 201, 'Welcome! Your loyalty card is ready', result);
});

export const listCustomers = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomers(req.user.storeId, req.query);

  return sendSuccess(res, 200, 'Customers retrieved', result);
});

export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomerById(
    req.user.storeId,
    req.params.customerId
  );

  return sendSuccess(res, 200, 'Customer retrieved', { customer });
});

export const lookupCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.lookupCustomerByPassId(
    req.user.storeId,
    req.body.passIdentifier
  );

  return sendSuccess(res, 200, 'Customer found', { customer });
});

export const addStamp = asyncHandler(async (req, res) => {
  const customer = await customerService.addStamp(
    req.user.storeId,
    req.params.customerId,
    req.user._id
  );

  return sendSuccess(res, 200, 'Stamp added', { customer });
});

export const redeemReward = asyncHandler(async (req, res) => {
  const customer = await customerService.redeemReward(
    req.user.storeId,
    req.params.customerId,
    req.user._id
  );

  return sendSuccess(res, 200, 'Reward redeemed', { customer });
});

export const getStats = asyncHandler(async (req, res) => {
  const stats = await customerService.getCustomerStats(req.user.storeId);

  return sendSuccess(res, 200, 'Customer stats retrieved', { stats });
});

export const getPublicCustomerCard = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.customerId);
  if (!customer) throw new ApiError(404, 'Customer not found');

  const store = await publicService.getPublicStore(customer.storeId);

  return sendSuccess(res, 200, 'Customer card retrieved', { customer, store });
});
