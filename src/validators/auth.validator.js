import { body } from 'express-validator';
import { ROLES, SUBSCRIPTION_PLANS } from '../utils/constants.js';

export const registerValidator = [
  body('ownerName')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Owner name cannot exceed 100 characters'),

  body('firstName')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 50 })
    .withMessage('First name cannot exceed 50 characters'),

  body('lastName')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 50 })
    .withMessage('Last name cannot exceed 50 characters'),

  body().custom((_, { req }) => {
    const hasOwner = Boolean(req.body.ownerName?.trim());
    const hasParts = Boolean(req.body.firstName?.trim() && req.body.lastName?.trim());
    if (!hasOwner && !hasParts) {
      throw new Error('Owner name is required');
    }
    return true;
  }),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .isLength({ max: 40 })
    .withMessage('Phone number cannot exceed 40 characters'),

  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),

  body('role')
    .optional()
    .isIn([ROLES.STORE_OWNER, ROLES.EMPLOYEE])
    .withMessage('Role must be store_owner or employee'),

  body('storeName')
    .trim()
    .notEmpty()
    .withMessage('Store name is required')
    .isLength({ max: 120 })
    .withMessage('Store name cannot exceed 120 characters'),

  body('websiteUrl')
    .trim()
    .notEmpty()
    .withMessage('Website URL is required')
    .isLength({ max: 2048 })
    .withMessage('Website URL cannot exceed 2048 characters'),

  body('country')
    .trim()
    .notEmpty()
    .withMessage('Country is required')
    .isLength({ max: 100 })
    .withMessage('Country cannot exceed 100 characters'),

  body('province')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Province cannot exceed 100 characters'),

  body('city')
    .trim()
    .notEmpty()
    .withMessage('City is required')
    .isLength({ max: 120 })
    .withMessage('City cannot exceed 120 characters'),

  body('address')
    .trim()
    .notEmpty()
    .withMessage('Address is required')
    .isLength({ max: 500 })
    .withMessage('Address cannot exceed 500 characters'),

  body('subscriptionPlan')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(Object.values(SUBSCRIPTION_PLANS))
    .withMessage('Invalid subscription plan'),
];

export const loginValidator = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('password').notEmpty().withMessage('Password is required'),
];

export const forgotPasswordValidator = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
];

export const resetPasswordValidator = [
  body('token').notEmpty().withMessage('Reset token is required'),

  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
];

export const updateProfileValidator = [
  body('firstName')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('First name cannot be empty')
    .isLength({ max: 50 })
    .withMessage('First name cannot exceed 50 characters'),

  body('lastName')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Last name cannot be empty')
    .isLength({ max: 50 })
    .withMessage('Last name cannot exceed 50 characters'),

  body('phone')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 40 })
    .withMessage('Phone number cannot exceed 40 characters'),
];
