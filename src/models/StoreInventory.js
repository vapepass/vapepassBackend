import mongoose from 'mongoose';

/**
 * Dedicated Store Inventory — one document per purchasable product/variant per retailer.
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
    /** Full product/variant description used by the AI recommendation engine */
    description: {
      type: String,
      default: null,
      maxlength: 4000,
    },
    descriptionHash: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
      index: true,
    },
    descriptionSource: {
      type: String,
      enum: ['product', 'subcategory', 'category', 'shared'],
      default: null,
    },
    imageUrl: {
      type: String,
      default: null,
      trim: true,
      maxlength: 2048,
    },
    category: {
      type: String,
      default: null,
      trim: true,
      maxlength: 160,
    },
    subcategory: {
      type: String,
      default: null,
      trim: true,
      maxlength: 160,
    },
    variantName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },
    /** Parent catalog product id before variant explosion (e.g. shopify:handle) */
    parentExternalId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    nicotineMgMl: {
      type: Number,
      default: null,
      min: 0,
    },
    /** Display string for nicotine strength when available (e.g. "12mg") */
    nicotineStrength: {
      type: String,
      default: null,
      trim: true,
      maxlength: 40,
    },
    volumeMl: {
      type: Number,
      default: null,
      min: 0,
    },
    bottleSize: {
      type: String,
      default: null,
      trim: true,
      maxlength: 40,
    },
    price: {
      type: Number,
      default: null,
      min: 0,
    },
    productType: {
      type: String,
      enum: ['e_liquid', 'pod', 'cartridge', 'prefilled', 'device', 'other'],
      default: 'other',
    },
    /**
     * Original product page URL on the storefront (unchanged).
     * Variants share their parent PDP URL so customers can open the exact page.
     */
    productUrl: {
      type: String,
      default: null,
      trim: true,
      maxlength: 2048,
    },
    /** Stable id from the source platform (Shopify handle+variantId, Woo id, etc.) */
    externalId: {
      type: String,
      required: true,
      trim: true,
    },
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
storeInventorySchema.index({ storeId: 1, category: 1, subcategory: 1 });

const StoreInventory = mongoose.model('StoreInventory', storeInventorySchema);

export default StoreInventory;
