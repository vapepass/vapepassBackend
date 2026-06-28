import { Router } from 'express';
import { authenticateUser, authorizeRoles } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadLogo, handleMulterError } from '../middleware/upload.js';
import { storeSettingsValidator } from '../validators/store.validator.js';
import { inviteEmployeeValidator } from '../validators/employee.validator.js';
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

/**
 * @swagger
 * /store/employees:
 *   get:
 *     summary: List store employees (store owners only)
 *     tags: [Store]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Employees retrieved
 *   post:
 *     summary: Invite a new employee (store owners only)
 *     tags: [Store]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, email, password]
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       201:
 *         description: Employee invited
 */
router.get(
  '/employees',
  authorizeRoles(ROLES.STORE_OWNER),
  storeController.listEmployees
);

router.post(
  '/employees',
  authorizeRoles(ROLES.STORE_OWNER),
  validate(inviteEmployeeValidator),
  storeController.inviteEmployee
);

/**
 * @swagger
 * /store/employees/{employeeId}:
 *   delete:
 *     summary: Deactivate an employee (store owners only)
 *     tags: [Store]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Employee deactivated
 */
router.delete(
  '/employees/:employeeId',
  authorizeRoles(ROLES.STORE_OWNER),
  storeController.deactivateEmployee
);

export default router;
