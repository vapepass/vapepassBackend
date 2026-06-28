import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import { activityListValidator } from '../validators/customer.validator.js';
import * as activityController from '../controllers/activity.controller.js';

const router = Router();

router.use(authenticateUser, ...requireActiveSubscription);

router.get('/', validate(activityListValidator), activityController.listActivity);

export default router;
