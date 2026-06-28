import mongoose from 'mongoose';
import { CUSTOMER_STATUS } from '../utils/constants.js';

const customerSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      maxlength: 120,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    stamps: {
      type: Number,
      default: 0,
      min: 0,
    },
    stampGoal: {
      type: Number,
      required: true,
      min: 1,
    },
    passIdentifier: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    passKitMemberId: {
      type: String,
      default: null,
    },
    appleWalletUrl: {
      type: String,
      default: null,
    },
    googleWalletUrl: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(CUSTOMER_STATUS),
      default: CUSTOMER_STATUS.ACTIVE,
    },
    verificationCodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VerificationCode',
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

customerSchema.index({ storeId: 1, phone: 1 });
customerSchema.index({ storeId: 1, fullName: 1 });

const Customer = mongoose.model('Customer', customerSchema);

export default Customer;
