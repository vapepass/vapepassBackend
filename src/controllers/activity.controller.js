import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as activityService from '../services/activity.service.js';

export const listActivity = asyncHandler(async (req, res) => {
  const result = await activityService.getStoreActivity(req.user.storeId, req.query);

  return sendSuccess(res, 200, 'Activity log retrieved', result);
});
