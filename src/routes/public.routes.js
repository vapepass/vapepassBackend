import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { joinCustomerValidator } from '../validators/customer.validator.js';
import * as publicController from '../controllers/public.controller.js';
import * as customerController from '../controllers/customer.controller.js';

const router = Router();

router.get('/stores/:storeId', publicController.getPublicStore);

router.post(
  '/stores/:storeId/join',
  validate(joinCustomerValidator),
  customerController.joinCustomer
);

router.get('/customers/:customerId/card', customerController.getPublicCustomerCard);

export default router;
