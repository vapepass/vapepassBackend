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
    /**
     * Dynamic GPT funnel state — depth and options come from store taxonomy,
     * not hardcoded frontend steps.
     */
    funnelState: {
      type: {
        phase: {
          type: String,
          enum: ['age', 'funnel', 'variant_refine', 'recommendation', 'free_chat'],
          default: 'age',
        },
        currentStepId: { type: String, default: null },
        candidateProductIds: [{ type: String }],
        /** Parent catalog id when refining sibling flavor variants */
        parentExternalId: { type: String, default: null },
        /** Dimensions already asked during variant refine (ice, fruit, taste, …) */
        variantPath: [
          {
            dimension: String,
            optionId: String,
            label: String,
          },
        ],
        path: [
          {
            stepId: String,
            optionId: String,
            label: String,
          },
        ],
      },
      default: () => ({
        phase: 'age',
        currentStepId: null,
        candidateProductIds: [],
        parentExternalId: null,
        variantPath: [],
        path: [],
      }),
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
