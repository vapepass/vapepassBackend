import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { ROLES } from '../utils/constants.js';
import * as verificationController from '../controllers/verification.controller.js';

const router = Router();

router.use(authenticateUser, ...requireActiveSubscription);

router.post(
  '/',
  authorizeRoles(ROLES.STORE_OWNER, ROLES.EMPLOYEE),
  verificationController.generateCode
);

export default router;
