import { body, param } from 'express-validator';

export const storeIdParamValidator = [
  param('storeId')
    .isMongoId()
    .withMessage('Invalid store ID'),
];

export const productPageUrlValidator = [
  body('productPageUrl')
    .trim()
    .notEmpty()
    .withMessage('Store website URL is required')
    .isLength({ max: 2048 })
    .withMessage('Store website URL cannot exceed 2048 characters'),
  body('syncNow')
    .optional()
    .isBoolean()
    .withMessage('syncNow must be a boolean'),
];

export const chatMessageValidator = [
  body('storeId')
    .isMongoId()
    .withMessage('Invalid store ID'),
  body('sessionKey')
    .optional()
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage('Invalid session key'),
  body('message')
    .trim()
    .notEmpty()
    .withMessage('Message is required')
    .isLength({ max: 2000 })
    .withMessage('Message cannot exceed 2000 characters'),
];

export const startSessionValidator = [
  body('storeId')
    .isMongoId()
    .withMessage('Invalid store ID'),
  body('sessionKey')
    .optional()
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage('Invalid session key'),
];

export const priorityPromotionValidator = [
  param('productId')
    .isMongoId()
    .withMessage('Invalid product ID'),
  body('isPriorityPromotion')
    .isBoolean()
    .withMessage('isPriorityPromotion must be a boolean'),
];
