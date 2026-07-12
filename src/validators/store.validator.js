import { body } from 'express-validator';

export const storeSettingsValidator = [
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Store name cannot be empty')
    .isLength({ max: 120 })
    .withMessage('Store name cannot exceed 120 characters'),

  body('brandColor')
    .optional()
    .trim()
    .matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
    .withMessage('Brand color must be a valid hex code (e.g. #6C3CE1)'),

  body('rewardDescription')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Reward description cannot exceed 500 characters'),

  body('stampGoal')
    .optional()
    .toInt()
    .isInt({ min: 1, max: 50 })
    .withMessage('Stamp goal must be between 1 and 50'),

  body('productPageUrl')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 2048 })
    .withMessage('Product page URL cannot exceed 2048 characters'),

  body('address')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Address cannot exceed 500 characters'),

  body('country')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Country cannot exceed 100 characters'),

  body('province')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Province cannot exceed 100 characters'),
];
