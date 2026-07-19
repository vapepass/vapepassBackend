import { Router } from 'express';
import authRoutes from './auth.routes.js';
import storeRoutes from './store.routes.js';
import verificationRoutes from './verification.routes.js';
import customerRoutes from './customer.routes.js';
import activityRoutes from './activity.routes.js';
import billingRoutes from './billing.routes.js';
import analyticsRoutes from './analytics.routes.js';
import adminRoutes from './admin.routes.js';
import publicRoutes from './public.routes.js';
import assistantRoutes from './assistant.routes.js';
import cronRoutes from './cron.routes.js';
import supportRoutes from './support.routes.js';

const router = Router();

router.use('/public', publicRoutes);
router.use('/auth', authRoutes);
router.use('/store', storeRoutes);
router.use('/verification-codes', verificationRoutes);
router.use('/customers', customerRoutes);
router.use('/activity', activityRoutes);
router.use('/billing', billingRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/admin', adminRoutes);
router.use('/assistant', assistantRoutes);
router.use('/cron', cronRoutes);
router.use('/support', supportRoutes);

export default router;
