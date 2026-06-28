import { Router } from 'express';
import { body } from 'express-validator';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ROLES, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import * as adminController from '../controllers/admin.controller.js';

const router = Router();

router.use(authenticateUser, authorizeRoles(ROLES.ADMIN));

router.get('/overview', adminController.getOverview);
router.get('/businesses', adminController.getBusinesses);
router.get('/programs', adminController.getPrograms);

router.patch(
  '/businesses/:storeId/subscription',
  validate([
    body('subscriptionStatus')
      .isIn(Object.values(SUBSCRIPTION_STATUS))
      .withMessage('Invalid subscription status'),
  ]),
  adminController.updateBusinessStatus
);

export default router;
