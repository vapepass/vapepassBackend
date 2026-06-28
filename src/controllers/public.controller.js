import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as publicService from '../services/public.service.js';

export const getPublicStore = asyncHandler(async (req, res) => {
  const store = await publicService.getPublicStore(req.params.storeId);

  return sendSuccess(res, 200, 'Store retrieved', { store });
});
