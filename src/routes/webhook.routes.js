import { Router } from 'express';
import express from 'express';
import * as webhookController from '../controllers/webhook.controller.js';

const router = Router();

/**
 * @swagger
 * /webhooks/stripe:
 *   post:
 *     summary: Stripe subscription webhook endpoint
 *     tags: [Webhooks]
 *     description: Receives Stripe events for subscription lifecycle. Configure in Stripe Dashboard.
 *     responses:
 *       200:
 *         description: Webhook processed
 */
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  webhookController.stripeWebhook
);

export default router;
