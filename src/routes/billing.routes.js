import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { ROLES } from '../utils/constants.js';
import * as billingController from '../controllers/billing.controller.js';

const router = Router();

router.use(authenticateUser, authorizeRoles(ROLES.STORE_OWNER));

router.get('/', billingController.getBillingInfo);
router.post('/checkout', billingController.createCheckout);
router.post('/portal', billingController.createPortal);

export default router;
