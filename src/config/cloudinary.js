import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.js';

/**
 * Cloudinary SDK configuration.
 * Upload helpers live in services/cloudinary.service.js.
 */
export const configureCloudinary = () => {
  const { cloudName, apiKey, apiSecret } = env.cloudinary;

  if (!cloudName || !apiKey || !apiSecret) {
    console.warn('Cloudinary credentials not configured. Logo uploads will be disabled.');
    return false;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return true;
};

export { cloudinary };
