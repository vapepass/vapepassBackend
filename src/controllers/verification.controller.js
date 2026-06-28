import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as verificationService from '../services/verification.service.js';

export const generateCode = asyncHandler(async (req, res) => {
  const { code, expiresAt } = await verificationService.createVerificationCode(
    req.user.storeId,
    req.user._id
  );

  return sendSuccess(res, 201, 'Verification code generated', {
    code,
    expiresAt,
    expiresInMinutes: 10,
  });
});
