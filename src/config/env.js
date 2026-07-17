import dotenv from 'dotenv';

dotenv.config();

const requiredEnv = ['MONGO_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`Warning: ${key} is not set in environment variables.`);
  }
}

export const env = {
  port: parseInt(process.env.PORT, 10) || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vapepass',
  jwtSecret: process.env.JWT_SECRET,
  jwtExpires: process.env.JWT_EXPIRES || '15m',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  /** Comma-separated hostnames allowed as marketing/demo chatbot origins */
  marketingDemoHosts: String(process.env.MARKETING_DEMO_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
  passkit: {
    apiKey: process.env.PASSKIT_API_KEY,
    apiSecret: process.env.PASSKIT_API_SECRET,
    programId: process.env.PASSKIT_PROGRAM_ID,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    priceId: process.env.STRIPE_PRICE_ID,
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  email: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
    logoUrl: process.env.EMAIL_LOGO_URL,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  scrapingBee: {
    apiKey: process.env.SCRAPINGBEE_API_KEY,
  },
  cronSecret: process.env.CRON_SECRET,
  enableInternalCron: process.env.ENABLE_INTERNAL_CRON === 'true',
  apiPublicUrl: process.env.API_PUBLIC_URL || process.env.CLIENT_URL || 'http://localhost:5000',
  nodeEnv: process.env.NODE_ENV || 'development',
};
