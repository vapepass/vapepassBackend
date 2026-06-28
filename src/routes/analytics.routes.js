import { Router } from 'express';
import express from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { ROLES } from '../utils/constants.js';
import * as analyticsController from '../controllers/analytics.controller.js';

const router = Router();

router.get(
  '/dashboard',
  authenticateUser,
  requireActiveSubscription,
  authorizeRoles(ROLES.STORE_OWNER, ROLES.EMPLOYEE),
  analyticsController.getDashboard
);

export default router;
