import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: {
      type: String,
      required: true,
      maxlength: 4000,
    },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const chatSessionSchema = new mongoose.Schema(
  {
    sessionKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    ageVerified: {
      type: Boolean,
      default: false,
    },
    locked: {
      type: Boolean,
      default: false,
    },
    lockReason: {
      type: String,
      default: null,
    },
    messages: {
      type: [messageSchema],
      default: [],
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  }
);

chatSessionSchema.index({ storeId: 1, createdAt: -1 });

const ChatSession = mongoose.model('ChatSession', chatSessionSchema);

export default ChatSession;
