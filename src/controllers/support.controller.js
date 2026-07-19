import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as supportService from '../services/support.service.js';

export const createSetupRequest = asyncHandler(async (req, res) => {
  const data = await supportService.createSetupAssistanceRequest(req.body, req.user);
  return sendSuccess(res, 201, 'Setup request submitted successfully', data);
});
