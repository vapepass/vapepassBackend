import mongoose from 'mongoose';
import { ROLES, SUBSCRIPTION_STATUS } from '../utils/constants.js';

const storeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Store name is required'],
      trim: true,
      maxlength: [120, 'Store name cannot exceed 120 characters'],
    },
    logo: {
      type: String,
      default: null,
    },
    brandColor: {
      type: String,
      default: '#6C3CE1',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Brand color must be a valid hex code'],
    },
    rewardDescription: {
      type: String,
      default: 'Collect stamps and earn a reward!',
      maxlength: [500, 'Reward description cannot exceed 500 characters'],
    },
    stampGoal: {
      type: Number,
      default: 10,
      min: [1, 'Stamp goal must be at least 1'],
      max: [50, 'Stamp goal cannot exceed 50'],
    },
    subscriptionStatus: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.TRIAL,
    },
    passKitProgramId: {
      type: String,
      default: null,
    },
    passKitTemplateId: {
      type: String,
      default: null,
    },
    stripeCustomerId: {
      type: String,
      default: null,
    },
    stripeSubscriptionId: {
      type: String,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  }
);

storeSchema.index({ createdBy: 1 });

const Store = mongoose.model('Store', storeSchema);

export default Store;
