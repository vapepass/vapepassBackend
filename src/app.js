import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { swaggerSpec } from './config/swagger.js';
import { configureCloudinary } from './config/cloudinary.js';
import webhookRoutes from './routes/webhook.routes.js';
import apiRoutes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

const app = express();

// Cloudinary (optional — logs warning if credentials missing)
configureCloudinary();

// CORS — allow frontend origin with credentials for refresh token cookies
app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Stripe webhooks require the raw request body
app.use('/api/v1/webhooks', webhookRoutes);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Swagger API documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'VapePass API Docs',
  swaggerOptions: {
    persistAuthorization: true,
  },
}));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'VapePass API is running' });
});

// API v1 routes
app.use('/api/v1', apiRoutes);

// 404 and global error handlers
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
