import mongoose from 'mongoose';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS } from '../utils/constants.js';
import { extractHostname } from '../utils/domain.js';
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
    subscriptionPlan: {
      type: String,
      enum: Object.values(SUBSCRIPTION_PLANS),
      default: SUBSCRIPTION_PLANS.PRO,
    },
    subscriptionStartDate: {
      type: Date,
      default: null,
    },
    subscriptionEndDate: {
      type: Date,
      default: null,
    },
    nextBillingDate: {
      type: Date,
      default: null,
    },
    paymentRetryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    renewalReminderSentAt: {
      type: Date,
      default: null,
    },
    lastPaymentFailedAt: {
      type: Date,
      default: null,
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
    /**
     * Auto Subscription (auto-renew). Default ON for new stores.
     * When false, Stripe subscription is set to cancel_at_period_end.
     */
    autoRenew: {
      type: Boolean,
      default: true,
    },
    autoRenewUpdatedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /** Authorized store website URL — embed script only works on this domain */
    websiteUrl: {
      type: String,
      default: null,
      trim: true,
      maxlength: [2048, 'Website URL cannot exceed 2048 characters'],
    },
    /** Normalized hostname derived from websiteUrl / productPageUrl for embed checks */
    allowedHostname: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: [253, 'Hostname cannot exceed 253 characters'],
    },
    /** Product listing page URL used for daily inventory sync (defaults to websiteUrl) */
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
    /** Set when store owner clicks Finish Setup / Go Live */
    setupCompletedAt: {
      type: Date,
      default: null,
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
    /** First automatic inventory scrape completed after onboarding */
    inventoryInitialSyncedAt: {
      type: Date,
      default: null,
    },
    /**
     * Manual Refresh Inventory quota — resets each calendar month (UTC).
     * Owners get 2 refreshes / month after the initial scrape.
     */
    inventoryRefreshMonthKey: {
      type: String,
      default: null,
      trim: true,
      maxlength: 7,
    },
    inventoryRefreshCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    detectedPlatform: {
      type: String,
      enum: ['shopify', 'woocommerce', 'generic', 'unknown'],
      default: undefined,
    },
    /**
     * GPT-built dynamic recommendation hierarchy for the chatbot funnel.
     * Shape: { entryStepId, steps: { [id]: { id, prompt, options[] } } }
     */
    recommendationTaxonomy: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    recommendationTaxonomyStatus: {
      type: String,
      enum: ['idle', 'pending', 'building', 'ready', 'error'],
      default: 'idle',
    },
    recommendationTaxonomyError: {
      type: String,
      default: null,
      maxlength: 1000,
    },
    recommendationTaxonomyBuiltAt: {
      type: Date,
      default: null,
    },
    /** Street address for the store (used for location-based compliance) */
    address: {
      type: String,
      default: null,
      trim: true,
      maxlength: [500, 'Address cannot exceed 500 characters'],
    },
    city: {
      type: String,
      default: null,
      trim: true,
      maxlength: [120, 'City cannot exceed 120 characters'],
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

/** Keep legalAge + allowedHostname in sync when related fields change */
storeSchema.pre('save', function (next) {
  if (
    this.isNew ||
    this.isModified('country') ||
    this.isModified('province') ||
    this.isModified('address')
  ) {
    this.legalAge = getLegalAge(this.country, this.province);
  }

  if (
    this.isNew ||
    this.isModified('websiteUrl') ||
    this.isModified('productPageUrl') ||
    this.isModified('allowedHostname')
  ) {
    const sourceUrl = this.websiteUrl || this.productPageUrl;
    if (sourceUrl) {
      this.allowedHostname = extractHostname(sourceUrl);
      if (!this.websiteUrl && this.productPageUrl) {
        this.websiteUrl = this.productPageUrl;
      }
      if (!this.productPageUrl && this.websiteUrl) {
        this.productPageUrl = this.websiteUrl;
      }
    }
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
