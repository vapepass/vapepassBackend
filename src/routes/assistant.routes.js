import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../utils/constants.js';
import {
  storeIdParamValidator,
  productPageUrlValidator,
  chatMessageValidator,
  startSessionValidator,
  priorityPromotionValidator,
} from '../validators/assistant.validator.js';
import * as assistantController from '../controllers/assistant.controller.js';

const router = Router();

/**
 * @swagger
 * /assistant/widget/{storeId}:
 *   get:
 *     summary: Public widget configuration for a store
 *     tags: [Assistant]
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Widget config
 */
router.get(
  '/widget/:storeId',
  validate(storeIdParamValidator),
  assistantController.getWidgetConfig
);

/**
 * @swagger
 * /assistant/session:
 *   post:
 *     summary: Start or resume a public chat session
 *     tags: [Assistant]
 */
router.post(
  '/session',
  validate(startSessionValidator),
  assistantController.startSession
);

/**
 * @swagger
 * /assistant/chat:
 *   post:
 *     summary: Send a customer message to VapePass Assistant
 *     tags: [Assistant]
 */
router.post(
  '/chat',
  validate(chatMessageValidator),
  assistantController.sendMessage
);

// Store-owner management routes
router.use(authenticateUser);

/**
 * @swagger
 * /assistant/status:
 *   get:
 *     summary: Get assistant onboarding status and embed code
 *     tags: [Assistant]
 *     security:
 *       - bearerAuth: []
 */
router.get('/status', assistantController.getAssistantStatus);

/**
 * @swagger
 * /assistant/product-url:
 *   put:
 *     summary: Set store product page URL and sync inventory
 *     tags: [Assistant]
 *     security:
 *       - bearerAuth: []
 */
router.put(
  '/product-url',
  authorizeRoles(ROLES.STORE_OWNER),
  validate(productPageUrlValidator),
  assistantController.setProductPageUrl
);

/**
 * @swagger
 * /assistant/sync:
 *   post:
 *     summary: Manually trigger inventory sync for the store
 *     tags: [Assistant]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/sync',
  authorizeRoles(ROLES.STORE_OWNER),
  assistantController.syncInventory
);

/**
 * @swagger
 * /assistant/inventory:
 *   get:
 *     summary: List synced inventory products for the store
 *     tags: [Assistant]
 *     security:
 *       - bearerAuth: []
 */
router.get('/inventory', assistantController.listInventory);

/**
 * @swagger
 * /assistant/inventory/{productId}/priority:
 *   patch:
 *     summary: Toggle "Push to Customers This Month" for an inventory product
 *     tags: [Assistant]
 *     security:
 *       - bearerAuth: []
 */
router.patch(
  '/inventory/:productId/priority',
  authorizeRoles(ROLES.STORE_OWNER),
  validate(priorityPromotionValidator),
  assistantController.setPriorityPromotion
);

export default router;
