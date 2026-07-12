import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { startInventoryCron } from './jobs/inventoryCron.js';

const MAX_DB_RETRIES = 5;
const DB_RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(attempt = 1) {
  try {
    await connectDB();
  } catch (error) {
    console.error(`MongoDB connection attempt ${attempt} failed: ${error.message}`);

    if (attempt >= MAX_DB_RETRIES) {
      console.error('MongoDB connection failed after maximum retries. API will stay up but database routes will fail.');
      return;
    }

    console.log(`Retrying MongoDB in ${DB_RETRY_DELAY_MS / 1000}s…`);
    await sleep(DB_RETRY_DELAY_MS);
    await connectWithRetry(attempt + 1);
  }
}

const startServer = async () => {
  app.listen(env.port, '0.0.0.0', () => {
    console.log(`VapePass API running on port ${env.port}`);
    console.log(`Health check: http://0.0.0.0:${env.port}/health`);
    console.log(`Swagger docs: http://0.0.0.0:${env.port}/api-docs`);
  });

  await connectWithRetry();
  startInventoryCron();
};

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
