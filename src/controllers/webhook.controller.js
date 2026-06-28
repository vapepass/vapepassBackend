import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ApiError } from '../utils/constants.js';
import { env } from '../config/env.js';
import * as stripeService from '../services/stripe.service.js';

export const stripeWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!env.stripe.webhookSecret) {
    throw new ApiError(503, 'Stripe webhook secret is not configured');
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.stripe.secretKey);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, env.stripe.webhookSecret);
  } catch (err) {
    throw new ApiError(400, `Webhook signature verification failed: ${err.message}`);
  }

  await stripeService.handleWebhookEvent(event);

  return sendSuccess(res, 200, 'Webhook received');
});
