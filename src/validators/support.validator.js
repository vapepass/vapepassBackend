import { body, param } from 'express-validator';
import { SETUP_REQUEST_STATUS } from '../utils/constants.js';

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

function normalizeWebsiteUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const createSetupRequestValidator = [
  body('name')
    .customSanitizer(stripTags)
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 120 })
    .withMessage('Name cannot exceed 120 characters'),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail()
    .isLength({ max: 254 })
    .withMessage('Email cannot exceed 254 characters'),

  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .isLength({ min: 7, max: 40 })
    .withMessage('Phone number must be between 7 and 40 characters')
    .matches(/^[\d\s+\-().]+$/)
    .withMessage('Please provide a valid phone number'),

  body('storeName')
    .customSanitizer(stripTags)
    .notEmpty()
    .withMessage('Store name is required')
    .isLength({ max: 120 })
    .withMessage('Store name cannot exceed 120 characters'),

  body('websiteUrl')
    .trim()
    .notEmpty()
    .withMessage('Website URL is required')
    .isLength({ max: 2048 })
    .withMessage('Website URL cannot exceed 2048 characters')
    .customSanitizer(normalizeWebsiteUrl)
    .custom((value) => {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('Website URL must start with http or https');
        }
        if (!url.hostname) {
          throw new Error('Please provide a valid website URL');
        }
        return true;
      } catch (err) {
        throw new Error(err.message || 'Please provide a valid website URL');
      }
    }),

  body('message')
    .optional({ values: 'falsy' })
    .customSanitizer(stripTags)
    .isLength({ max: 2000 })
    .withMessage('Message cannot exceed 2000 characters'),
];

export const updateSetupRequestStatusValidator = [
  param('requestId').isMongoId().withMessage('Invalid request id'),
  body('status')
    .trim()
    .notEmpty()
    .withMessage('Status is required')
    .isIn(Object.values(SETUP_REQUEST_STATUS))
    .withMessage(
      `Status must be one of: ${Object.values(SETUP_REQUEST_STATUS).join(', ')}`
    ),
];
