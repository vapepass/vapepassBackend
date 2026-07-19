import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ApiError } from '../utils/constants.js';
import * as adminService from '../services/admin.service.js';
import * as supportService from '../services/support.service.js';

export const getOverview = asyncHandler(async (req, res) => {
  const data = await adminService.getAdminOverview();
  return sendSuccess(res, 200, 'Admin overview retrieved', data);
});

export const getBusinesses = asyncHandler(async (req, res) => {
  const data = await adminService.getAdminBusinesses({
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
    status: req.query.status,
  });
  return sendSuccess(res, 200, 'Businesses retrieved', data);
});

export const getPrograms = asyncHandler(async (req, res) => {
  const programs = await adminService.getAdminPrograms();
  return sendSuccess(res, 200, 'Programs retrieved', { programs });
});

export const updateBusinessStatus = asyncHandler(async (req, res) => {
  const store = await adminService.updateBusinessSubscription(
    req.params.storeId,
    req.body.subscriptionStatus
  );

  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  return sendSuccess(res, 200, 'Subscription status updated', { store });
});

export const getSetupRequests = asyncHandler(async (req, res) => {
  const data = await supportService.listSetupRequests({
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
    status: req.query.status,
  });
  return sendSuccess(res, 200, 'Setup requests retrieved', data);
});

export const updateSetupRequestStatus = asyncHandler(async (req, res) => {
  const request = await supportService.updateSetupRequestStatus(
    req.params.requestId,
    req.body.status
  );

  if (!request) {
    throw new ApiError(404, 'Setup request not found');
  }

  return sendSuccess(res, 200, 'Setup request status updated', { request });
});
