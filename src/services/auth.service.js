import User from '../models/User.js';
import Store from '../models/Store.js';
import { ApiError, ROLES, SUBSCRIPTION_PLANS } from '../utils/constants.js';
import { extractHostname } from '../utils/domain.js';
import { generateResetToken, hashToken } from '../utils/token.js';
import { sanitizeUser } from '../utils/user.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from './token.service.js';
import { sendPasswordResetEmail } from './email.service.js';

function normalizeWebsiteUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = String(rawUrl).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    return new URL(url).toString();
  } catch {
    throw new ApiError(400, 'Please provide a valid website URL');
  }
}

function splitOwnerName(ownerName, firstName, lastName) {
  if (firstName && lastName) {
    return { firstName: firstName.trim(), lastName: lastName.trim() };
  }

  const parts = String(ownerName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: 'Owner' };
  }

  return { firstName: firstName || 'Store', lastName: lastName || 'Owner' };
}

export const registerUser = async ({
  firstName,
  lastName,
  ownerName,
  email,
  password,
  phone,
  role = ROLES.STORE_OWNER,
  storeName,
  websiteUrl,
  productPageUrl,
  country,
  province,
  city,
  address,
  subscriptionPlan,
}) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ApiError(409, 'An account with this email already exists');
  }

  if (role === ROLES.EMPLOYEE) {
    throw new ApiError(400, 'Employees must be invited by a store owner');
  }

  if (role === ROLES.ADMIN) {
    throw new ApiError(403, 'Admin accounts cannot be created via public registration');
  }

  const names = splitOwnerName(ownerName, firstName, lastName);
  const website = normalizeWebsiteUrl(websiteUrl || productPageUrl);

  if (!website) {
    throw new ApiError(400, 'Website URL is required');
  }

  if (!storeName?.trim()) {
    throw new ApiError(400, 'Store name is required');
  }

  const user = await User.create({
    firstName: names.firstName,
    lastName: names.lastName,
    email,
    phone: phone || null,
    password,
    role: ROLES.STORE_OWNER,
  });

  const store = await Store.create({
    name: storeName.trim(),
    createdBy: user._id,
    websiteUrl: website,
    productPageUrl: website,
    allowedHostname: extractHostname(website),
    country: country || 'CA',
    province: province || null,
    city: city || null,
    address: address || null,
    subscriptionPlan: subscriptionPlan || SUBSCRIPTION_PLANS.PRO,
    inventorySyncStatus: 'idle',
  });

  user.storeId = store._id;
  await user.save();

  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return {
    user: sanitizeUser(user),
    store,
    accessToken,
    refreshToken,
  };
};

export const loginUser = async (email, password) => {
  const user = await User.findOne({ email }).select('+password +refreshToken');

  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Invalid email or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Your account has been deactivated. Contact support.');
  }

  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken,
  };
};

export const logoutUser = async (userId) => {
  await User.findByIdAndUpdate(userId, { refreshToken: null });
};

export const getUserProfile = async (userId) => {
  const user = await User.findById(userId).populate('storeId');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return sanitizeUser(user);
};

export const updateUserProfile = async (userId, updates = {}) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  if (updates.firstName !== undefined) user.firstName = String(updates.firstName).trim();
  if (updates.lastName !== undefined) user.lastName = String(updates.lastName).trim();
  if (updates.phone !== undefined) {
    const phone = String(updates.phone || '').trim();
    user.phone = phone || null;
  }

  await user.save();
  return sanitizeUser(user);
};

export const forgotPassword = async (email) => {
  const user = await User.findOne({ email });

  // Always return success to prevent email enumeration
  if (!user) {
    return { resetToken: null };
  }

  const { resetToken, hashedToken } = generateResetToken();

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = Date.now() + 60 * 60 * 1000; // 1 hour
  await user.save({ validateBeforeSave: false });

  try {
    await sendPasswordResetEmail(user.email, resetToken);
  } catch (error) {
    console.error(`[email] Failed to send password reset to ${user.email}:`, error.message);
  }

  return { resetToken, email: user.email };
};

export const resetPassword = async (token, newPassword) => {
  const hashedToken = hashToken(token);

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  }).select('+passwordResetToken +passwordResetExpires');

  if (!user) {
    throw new ApiError(400, 'Password reset token is invalid or has expired');
  }

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.refreshToken = undefined;
  await user.save();

  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken,
  };
};

export const validateRefreshToken = async (token) => {
  try {
    const decoded = verifyRefreshToken(token);
    const user = await User.findById(decoded.id).select('+refreshToken');

    if (!user || user.refreshToken !== token) {
      throw new ApiError(401, 'Invalid refresh token');
    }

    return user;
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }
};
