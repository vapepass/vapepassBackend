import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadLogo, handleMulterError } from '../middleware/upload.js';
import { storeSettingsValidator } from '../validators/store.validator.js';
import { ROLES } from '../utils/constants.js';
import * as storeController from '../controllers/store.controller.js';

const router = Router();

router.use(authenticateUser);

/**
 * @swagger
 * /store:
 *   get:
 *     summary: Get the authenticated user's store
 *     tags: [Store]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Store retrieved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         store:
 *                           $ref: '#/components/schemas/Store'
 *       404:
 *         description: Store not found
 */
router.get('/', storeController.getStore);

/**
 * @swagger
 * /store/settings:
 *   put:
 *     summary: Update store settings (store owners only)
 *     tags: [Store]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               brandColor:
 *                 type: string
 *               rewardDescription:
 *                 type: string
 *               stampGoal:
 *                 type: integer
 *               logo:
 *                 type: string
 *                 format: binary
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StoreSettingsInput'
 *     responses:
 *       200:
 *         description: Store settings updated
 *       403:
 *         description: Forbidden — store owners only
 */
router.put(
  '/settings',
  authorizeRoles(ROLES.STORE_OWNER),
  uploadLogo,
  handleMulterError,
  validate(storeSettingsValidator),
  storeController.updateStoreSettings
);

export default router;
