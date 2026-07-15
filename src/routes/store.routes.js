import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import { uploadLogo, handleMulterError } from '../middleware/upload.js';
import { storeSettingsValidator } from '../validators/store.validator.js';
import { inviteEmployeeValidator } from '../validators/employee.validator.js';
import { ROLES } from '../utils/constants.js';
import * as storeController from '../controllers/store.controller.js';

const router = Router();

router.use(authenticateUser);

/**
 * GET /store — always available to authenticated store users
 * (needed during subscribe / pending payment flow).
 */
router.get('/', storeController.getStore);

router.put(
  '/settings',
  authorizeRoles(ROLES.STORE_OWNER),
  ...requireActiveSubscription,
  uploadLogo,
  handleMulterError,
  validate(storeSettingsValidator),
  storeController.updateStoreSettings
);

router.get(
  '/employees',
  authorizeRoles(ROLES.STORE_OWNER),
  ...requireActiveSubscription,
  storeController.listEmployees
);

router.post(
  '/employees',
  authorizeRoles(ROLES.STORE_OWNER),
  ...requireActiveSubscription,
  validate(inviteEmployeeValidator),
  storeController.inviteEmployee
);

router.delete(
  '/employees/:employeeId',
  authorizeRoles(ROLES.STORE_OWNER),
  ...requireActiveSubscription,
  storeController.deactivateEmployee
);

export default router;
