import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../utils/constants.js';
import {
  customerListValidator,
  customerLookupValidator,
} from '../validators/customer.validator.js';
import * as customerController from '../controllers/customer.controller.js';

const router = Router();

router.use(authenticateUser, requireActiveSubscription);

router.get('/stats', customerController.getStats);

router.get('/', validate(customerListValidator), customerController.listCustomers);

router.post(
  '/lookup',
  authorizeRoles(ROLES.STORE_OWNER, ROLES.EMPLOYEE),
  validate(customerLookupValidator),
  customerController.lookupCustomer
);

router.get('/:customerId', customerController.getCustomer);

router.post(
  '/:customerId/stamps',
  authorizeRoles(ROLES.STORE_OWNER, ROLES.EMPLOYEE),
  customerController.addStamp
);

router.post(
  '/:customerId/redeem',
  authorizeRoles(ROLES.STORE_OWNER, ROLES.EMPLOYEE),
  customerController.redeemReward
);

export default router;
