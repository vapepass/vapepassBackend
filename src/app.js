import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { configureCloudinary } from './config/cloudinary.js';
import { env } from './config/env.js';
import webhookRoutes from './routes/webhook.routes.js';
import apiRoutes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Cloudinary (optional — logs warning if credentials missing)
configureCloudinary();

// CORS — allow all origins (reflects request origin for credentials support)
app.use(
  cors({
    origin: (_origin, callback) => callback(null, true),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Vapepass-Parent-Origin'],
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

// Health check (used by Railway / uptime monitors)
app.get('/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    success: dbConnected,
    message: dbConnected ? 'VapePass API is running' : 'VapePass API is up but database is not connected',
    database: dbConnected ? 'connected' : 'disconnected',
  });
});

// Embeddable VapePass Assistant — thin loader that iframes the Next.js chat UI
app.get('/widget.js', (req, res) => {
  const widgetPath = path.join(__dirname, '../public/widget.js');
  fs.readFile(widgetPath, 'utf8', (err, source) => {
    if (err) {
      res.status(500).type('text/plain').send('Unable to load widget.js');
      return;
    }
    const clientUrl = String(env.clientUrl || 'http://localhost:3000').replace(/\/+$/, '');
    const body = source.replace(/__VAPEPASS_CLIENT_URL__/g, clientUrl);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(body);
  });
});

// Static assets (email logo, etc.)
app.use(express.static(path.join(__dirname, '../public'), { maxAge: '1d' }));

// API v1 routes
app.use('/api/v1', apiRoutes);

// 404 and global error handlers
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
