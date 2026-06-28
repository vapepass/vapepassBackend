import mongoose from 'mongoose';

const processedStripeEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

const ProcessedStripeEvent = mongoose.model('ProcessedStripeEvent', processedStripeEventSchema);

export default ProcessedStripeEvent;
