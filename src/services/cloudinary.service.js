import { cloudinary } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';

const isCloudinaryConfigured = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);

/**
 * Upload an image buffer to Cloudinary.
 * Returns the secure URL of the uploaded asset.
 */
export const uploadImage = async (fileBuffer, folder = 'vapepass/logos') => {
  if (!fileBuffer) {
    throw new ApiError(400, 'No file provided for upload');
  }

  if (!isCloudinaryConfigured()) {
    throw new ApiError(503, 'Image upload is not configured. Set Cloudinary credentials in .env');
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [{ width: 400, height: 400, crop: 'limit' }],
      },
      (error, result) => {
        if (error) {
          reject(new ApiError(500, 'Failed to upload image to Cloudinary'));
          return;
        }
        resolve(result.secure_url);
      }
    );

    stream.end(fileBuffer);
  });
};

/**
 * Remove an image from Cloudinary by public ID or URL.
 */
export const deleteImage = async (publicId) => {
  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId);
  } catch {
    // Non-critical — log in production monitoring
  }
};
