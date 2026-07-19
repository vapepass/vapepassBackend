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
     * Conversation / funnel state.
     * Prefer = NLP preference-driven shopping; funnel = legacy taxonomy steps.
     */
    funnelState: {
      type: {
        phase: {
          type: String,
          enum: [
            'age',
            'prefer',
            'preference',
            'funnel',
            'variant_refine',
            'recommendation',
            'free_chat',
          ],
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
        /** Free-text preference hints collected during conversation */
        preferenceHints: [{ type: String }],
        /** Structured NLP preferences for dynamic shopping flow */
        preferences: {
          type: mongoose.Schema.Types.Mixed,
          default: null,
        },
        /** Last missing preference we asked about (cooling, flavor, productType) */
        lastAsked: { type: String, default: null },
        /** How many times we've re-asked each missing preference */
        askAttempts: {
          type: mongoose.Schema.Types.Mixed,
          default: () => ({}),
        },
        /** Last clarification / follow-up text (avoids identical repeats) */
        lastAskText: { type: String, default: null },
      },
      default: () => ({
        phase: 'age',
        currentStepId: null,
        candidateProductIds: [],
        parentExternalId: null,
        variantPath: [],
        path: [],
        preferenceHints: [],
        preferences: null,
        lastAsked: null,
        askAttempts: {},
        lastAskText: null,
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
