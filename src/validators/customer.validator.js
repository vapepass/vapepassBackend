import { body, param, query } from 'express-validator';

export const joinCustomerValidator = [
  param('storeId').isMongoId().withMessage('Invalid store ID'),

  body('code')
    .trim()
    .notEmpty()
    .withMessage('Verification code is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('Verification code must be 6 digits'),

  body('fullName').trim().notEmpty().withMessage('Full name is required'),

  body('phone').trim().notEmpty().withMessage('Phone number is required'),

  body('email').optional().trim().isEmail().withMessage('Please provide a valid email'),
];

export const customerLookupValidator = [
  body('passIdentifier')
    .trim()
    .notEmpty()
    .withMessage('Pass identifier or QR payload is required'),
];

export const customerListValidator = [
  query('search').optional().trim(),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const activityListValidator = [
  query('type')
    .optional()
    .isIn(['all', 'verification_code', 'customer_joined', 'stamp_added', 'reward_earned']),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
];
