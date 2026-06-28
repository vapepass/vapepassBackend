import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as storeService from '../services/store.service.js';
import * as employeeService from '../services/employee.service.js';

export const getStore = asyncHandler(async (req, res) => {
  const store = await storeService.getStoreByUser(req.user);

  return sendSuccess(res, 200, 'Store retrieved successfully', { store });
});

export const updateStoreSettings = asyncHandler(async (req, res) => {
  const store = await storeService.updateStoreSettings(
    req.user,
    req.body,
    req.file
  );

  return sendSuccess(res, 200, 'Store settings updated successfully', { store });
});

export const inviteEmployee = asyncHandler(async (req, res) => {
  const employee = await employeeService.inviteEmployee(req.user, req.body);

  return sendSuccess(res, 201, 'Employee invited successfully', { employee });
});

export const listEmployees = asyncHandler(async (req, res) => {
  const employees = await employeeService.listEmployees(req.user);

  return sendSuccess(res, 200, 'Employees retrieved successfully', { employees });
});

export const deactivateEmployee = asyncHandler(async (req, res) => {
  const employee = await employeeService.deactivateEmployee(req.user, req.params.employeeId);

  return sendSuccess(res, 200, 'Employee deactivated successfully', { employee });
});
