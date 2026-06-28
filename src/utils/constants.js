export class ApiError extends Error {
  constructor(statusCode, message, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const ROLES = {
  ADMIN: 'admin',
  STORE_OWNER: 'store_owner',
  EMPLOYEE: 'employee',
};

export const SUBSCRIPTION_STATUS = {
  TRIAL: 'trial',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  PAUSED: 'paused',
};

export const ACTIVITY_TYPES = {
  VERIFICATION_CODE: 'verification_code',
  CUSTOMER_JOINED: 'customer_joined',
  STAMP_ADDED: 'stamp_added',
  REWARD_EARNED: 'reward_earned',
  REWARD_REDEEMED: 'reward_redeemed',
};

export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  REWARDED: 'rewarded',
};
