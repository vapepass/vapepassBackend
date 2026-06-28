import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';

const startServer = async () => {
  await connectDB();

  app.listen(env.port, () => {
    console.log(`VapePass API running on port ${env.port}`);
    console.log(`Swagger docs: http://localhost:${env.port}/api-docs`);
    console.log(`Health check: http://localhost:${env.port}/health`);
  });
};

startServer();
