import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { ROLES } from '../utils/constants.js';
import * as billingController from '../controllers/billing.controller.js';

const router = Router();

router.use(authenticateUser, authorizeRoles(ROLES.STORE_OWNER));

/**
 * @swagger
 * /billing:
 *   get:
 *     summary: Get billing plan info
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Billing info retrieved
 */
router.get('/', billingController.getBillingInfo);

/**
 * @swagger
 * /billing/checkout:
 *   post:
 *     summary: Create Stripe Checkout session for subscription
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Checkout session URL returned
 */
router.post('/checkout', billingController.createCheckout);

/**
 * @swagger
 * /billing/portal:
 *   post:
 *     summary: Create Stripe Customer Portal session
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Portal session URL returned
 */
router.post('/portal', billingController.createPortal);

export default router;
