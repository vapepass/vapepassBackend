import mongoose from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { getLegalAge } from '../utils/legalAge.js';

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
    /** Product listing page URL used for daily inventory sync */
    productPageUrl: {
      type: String,
      default: null,
      trim: true,
      maxlength: [2048, 'Product page URL cannot exceed 2048 characters'],
    },
    assistantEnabled: {
      type: Boolean,
      default: false,
    },
    inventorySyncStatus: {
      type: String,
      enum: ['idle', 'pending', 'syncing', 'success', 'error'],
      default: 'idle',
    },
    inventorySyncError: {
      type: String,
      default: null,
      maxlength: 1000,
    },
    lastInventorySyncAt: {
      type: Date,
      default: null,
    },
    inventoryProductCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    inventorySyncAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    detectedPlatform: {
      type: String,
      enum: ['shopify', 'woocommerce', 'generic', 'unknown'],
      default: undefined,
    },
    /** Street address for the store (used for location-based compliance) */
    address: {
      type: String,
      default: null,
      trim: true,
      maxlength: [500, 'Address cannot exceed 500 characters'],
    },
    /** ISO-style country code or full name (e.g. CA, US, Canada, United States) */
    country: {
      type: String,
      default: 'CA',
      trim: true,
      maxlength: [100, 'Country cannot exceed 100 characters'],
    },
    /** Province or state code/name (e.g. BC, ON, Alberta, California) */
    province: {
      type: String,
      default: null,
      trim: true,
      maxlength: [100, 'Province cannot exceed 100 characters'],
    },
    /** Legal purchasing age — auto-calculated from country/province; never manually set by users */
    legalAge: {
      type: Number,
      min: [18, 'Legal age must be at least 18'],
      max: [21, 'Legal age cannot exceed 21'],
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  }
);

/** Recalculate legalAge whenever location fields change */
storeSchema.pre('save', function (next) {
  if (
    this.isNew ||
    this.isModified('country') ||
    this.isModified('province') ||
    this.isModified('address')
  ) {
    this.legalAge = getLegalAge(this.country, this.province);
  }
  next();
});

/** Keep legalAge in sync when updates use findByIdAndUpdate / findOneAndUpdate */
storeSchema.pre('findOneAndUpdate', async function (next) {
  const update = this.getUpdate();
  if (!update) return next();

  const $set = update.$set || update;
  if ($set.country === undefined && $set.province === undefined && $set.address === undefined) {
    return next();
  }

  const existing = await this.model.findOne(this.getQuery()).select('country province').lean();
  const country = $set.country !== undefined ? $set.country : existing?.country;
  const province = $set.province !== undefined ? $set.province : existing?.province;
  const legalAge = getLegalAge(country, province);

  if (update.$set) {
    update.$set.legalAge = legalAge;
  } else {
    update.legalAge = legalAge;
  }

  next();
});

storeSchema.index({ createdBy: 1 });

const Store = mongoose.model('Store', storeSchema);

export default Store;
