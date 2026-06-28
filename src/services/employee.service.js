import User from '../models/User.js';
import { ApiError, ROLES } from '../utils/constants.js';
import { sanitizeUser } from '../utils/user.js';

export const inviteEmployee = async (owner, { firstName, lastName, email, password }) => {
  if (owner.role !== ROLES.STORE_OWNER) {
    throw new ApiError(403, 'Only store owners can invite employees');
  }

  if (!owner.storeId) {
    throw new ApiError(403, 'No store associated with this account');
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ApiError(409, 'An account with this email already exists');
  }

  const employee = await User.create({
    firstName,
    lastName,
    email,
    password,
    role: ROLES.EMPLOYEE,
    storeId: owner.storeId,
  });

  return sanitizeUser(employee);
};

export const listEmployees = async (owner) => {
  if (!owner.storeId) {
    throw new ApiError(403, 'No store associated with this account');
  }

  const employees = await User.find({
    storeId: owner.storeId,
    role: ROLES.EMPLOYEE,
  }).sort({ createdAt: -1 });

  return employees.map(sanitizeUser);
};

export const deactivateEmployee = async (owner, employeeId) => {
  if (owner.role !== ROLES.STORE_OWNER) {
    throw new ApiError(403, 'Only store owners can manage employees');
  }

  const employee = await User.findOne({
    _id: employeeId,
    storeId: owner.storeId,
    role: ROLES.EMPLOYEE,
  });

  if (!employee) {
    throw new ApiError(404, 'Employee not found');
  }

  employee.isActive = false;
  employee.refreshToken = undefined;
  await employee.save({ validateBeforeSave: false });

  return sanitizeUser(employee);
};
