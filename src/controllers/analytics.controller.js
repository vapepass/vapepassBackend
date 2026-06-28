import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as analyticsService from '../services/analytics.service.js';

export const getDashboard = asyncHandler(async (req, res) => {
  const data = await analyticsService.getStoreDashboardAnalytics(req.user.storeId);

  return sendSuccess(res, 200, 'Dashboard analytics retrieved', data);
});
