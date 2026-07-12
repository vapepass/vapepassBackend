import mongoose from 'mongoose';

/**
 * Dedicated Store Inventory collection — one document per product per retailer.
 * Upserts by (storeId, externalId) prevent duplicates across scrape runs.
 */
const storeInventorySchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    brand: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },
    flavor: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },
    nicotineMgMl: {
      type: Number,
      default: null,
      min: 0,
    },
    volumeMl: {
      type: Number,
      default: null,
      min: 0,
    },
    productType: {
      type: String,
      enum: ['e_liquid', 'pod', 'cartridge', 'prefilled', 'device', 'other'],
      default: 'other',
    },
    productUrl: {
      type: String,
      default: null,
      trim: true,
    },
    /** Stable id from the source platform (Shopify handle, Woo id, etc.) */
    externalId: {
      type: String,
      required: true,
      trim: true,
    },
    /** active | inactive — mirrors isActive for dashboard display */
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    /**
     * "Push to Customers This Month" — chatbot prioritizes these products.
     * Preserved across inventory re-syncs.
     */
    isPriorityPromotion: {
      type: Boolean,
      default: false,
      index: true,
    },
    platform: {
      type: String,
      enum: ['shopify', 'woocommerce', 'generic', 'unknown'],
      default: 'unknown',
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    collection: 'store_inventories',
  }
);

storeInventorySchema.index({ storeId: 1, externalId: 1 }, { unique: true });
storeInventorySchema.index({ storeId: 1, isActive: 1 });
storeInventorySchema.index({ storeId: 1, isPriorityPromotion: 1 });
storeInventorySchema.index({ storeId: 1, status: 1 });

const StoreInventory = mongoose.model('StoreInventory', storeInventorySchema);

export default StoreInventory;
