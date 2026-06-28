import VerificationCode from '../models/VerificationCode.js';
import { ApiError } from '../utils/constants.js';
import { ACTIVITY_TYPES } from '../utils/constants.js';
import { logActivity } from './activity.service.js';

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

const generateSixDigitCode = () => String(Math.floor(100000 + Math.random() * 900000));

export const createVerificationCode = async (storeId, userId) => {
  let code;
  let attempts = 0;

  // Ensure unique active code per store
  while (attempts < 5) {
    code = generateSixDigitCode();
    const existing = await VerificationCode.findOne({
      storeId,
      code,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!existing) break;
    attempts += 1;
  }

  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MS);

  const verificationCode = await VerificationCode.create({
    code,
    storeId,
    createdBy: userId,
    expiresAt,
  });

  await logActivity({
    storeId,
    type: ACTIVITY_TYPES.VERIFICATION_CODE,
    customerName: 'Walk-in customer',
    detail: `Age verification code ${code} issued — expires in 10 min`,
    performedBy: userId,
    metadata: { codeId: verificationCode._id, code },
  });

  return { code, expiresAt };
};

export const validateVerificationCode = async (storeId, code) => {
  const verification = await VerificationCode.findOne({
    storeId,
    code: String(code).trim(),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!verification) {
    throw new ApiError(400, 'Invalid or expired verification code');
  }

  return verification;
};
