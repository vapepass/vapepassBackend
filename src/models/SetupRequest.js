import mongoose from 'mongoose';
import { SETUP_REQUEST_STATUS } from '../utils/constants.js';

const setupRequestSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      maxlength: [120, 'Full name cannot exceed 120 characters'],
    },
    storeName: {
      type: String,
      required: [true, 'Store name is required'],
      trim: true,
      maxlength: [120, 'Store name cannot exceed 120 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email cannot exceed 254 characters'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      maxlength: [40, 'Phone number cannot exceed 40 characters'],
    },
    websiteUrl: {
      type: String,
      required: [true, 'Website URL is required'],
      trim: true,
      maxlength: [2048, 'Website URL cannot exceed 2048 characters'],
    },
    message: {
      type: String,
      trim: true,
      default: '',
      maxlength: [2000, 'Message cannot exceed 2000 characters'],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      default: null,
      index: true,
    },
    /** Stripe subscription id when available on the linked store */
    subscriptionId: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(SETUP_REQUEST_STATUS),
      default: SETUP_REQUEST_STATUS.PENDING,
      index: true,
    },
    customerEmailSentAt: {
      type: Date,
      default: null,
    },
    adminEmailSentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  }
);

setupRequestSchema.index({ email: 1, createdAt: -1 });
setupRequestSchema.index({ status: 1, createdAt: -1 });

const SetupRequest = mongoose.model('SetupRequest', setupRequestSchema);

export default SetupRequest;
