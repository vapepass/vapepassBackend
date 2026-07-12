import { Router } from 'express';
import { authenticateCron } from '../middleware/cronAuth.js';
import * as cronController from '../controllers/cron.controller.js';

const router = Router();

/**
 * @swagger
 * /cron/sync-inventory:
 *   post:
 *     summary: Daily inventory sync for all stores (cron secret required)
 *     tags: [Cron]
 *     security:
 *       - cronSecret: []
 */
router.post('/sync-inventory', authenticateCron, cronController.syncAllInventories);
router.get('/sync-inventory', authenticateCron, cronController.syncAllInventories);

export default router;
