import crypto from 'crypto';
import Store from '../models/Store.js';
import ChatSession from '../models/ChatSession.js';
import StoreInventory from '../models/StoreInventory.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import {
  buildSystemPrompt,
  detectsRecommendationRestart,
  detectsUnderage,
  formatInventoryForPrompt,
  getComplianceMessages,
  interpretAgeReply,
  isProductReferencedInReply,
  buildInventoryFallbackReply,
} from '../utils/compliance.js';
import { getAgeYesLabel, resolveStoreLegalAge } from '../utils/legalAge.js';
import { canServeChatbot } from '../utils/subscriptionAccess.js';
import { getRecommendableInventory } from './inventory.service.js';
import {
  advanceFunnel,
  beginFunnel,
  ensureStoreTaxonomy,
  resetFunnel,
  serializeProductCard,
} from './recommendationFunnel.service.js';

const MAX_HISTORY_MESSAGES = 20;

/**
 * Public widget bootstrap config for a store.
 */
export async function getWidgetConfig(storeId, options = {}) {
  const store =
    options.store ||
    (await Store.findById(storeId).select(
      'name brandColor assistantEnabled productPageUrl websiteUrl country province legalAge subscriptionStatus setupCompletedAt inventorySyncStatus inventoryProductCount'
    ));
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  // Fast path for bootstrap — avoid loading every inventory document into memory
  const productCount =
    typeof store.inventoryProductCount === 'number' && store.inventoryProductCount > 0
      ? store.inventoryProductCount
      : await StoreInventory.countDocuments({ storeId: store._id, isActive: true });

  const compliance = getComplianceMessages(store);
  const domainDenied = Boolean(options.domainDenied);
  const demoMode = Boolean(options.demoMode);
  const serveOk = canServeChatbot(store, { demoMode });
  const enabled = !domainDenied && serveOk && productCount > 0;

  return {
    storeId: store._id,
    storeName: store.name,
    brandColor: store.brandColor,
    legalAge: compliance.legalAge,
    regionLabel: compliance.regionLabel,
    minimumAgeLabel: `Minimum Age: ${compliance.legalAge}+`,
    healthWarning: compliance.healthWarning,
    ageQuestion: compliance.ageQuestion,
    ageYesLabel: getAgeYesLabel(compliance.legalAge),
    lockMessage: compliance.lockMessage,
    poweredBy: 'Powered by VapePass',
    requireSiteAgeGate: true,
    guidedFunnel: true,
    enabled,
    disabledReason: domainDenied
      ? 'unauthorized_domain'
      : !serveOk
        ? 'subscription_or_setup'
        : productCount === 0
          ? 'no_inventory'
          : null,
    productCount,
    syncing: store.inventorySyncStatus === 'syncing' || store.inventorySyncStatus === 'pending',
  };
}

/**
 * Start or resume a chat session. Returns the opening age-verification prompt when new.
 */
export async function startSession(storeId, sessionKey, options = {}) {
  const store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  if (!canServeChatbot(store, { demoMode: options.demoMode })) {
    throw new ApiError(402, 'Chatbot is unavailable for this store');
  }

  const compliance = getComplianceMessages(store);

  let session = sessionKey
    ? await ChatSession.findOne({ sessionKey, storeId })
    : null;

  if (!session) {
    session = await ChatSession.create({
      sessionKey: sessionKey || crypto.randomUUID(),
      storeId,
      ageVerified: false,
      locked: false,
      funnelState: {
        phase: 'age',
        currentStepId: null,
        candidateProductIds: [],
        path: [],
      },
      messages: [
        {
          role: 'assistant',
          content: compliance.ageQuestion,
        },
      ],
      lastMessageAt: new Date(),
    });
  }

  return serializeSession(session, store, compliance);
}

/**
 * Process a customer message with compliance + dynamic GPT funnel.
 */
export async function sendMessage(storeId, sessionKey, message, options = {}) {
  const content = String(message || '').trim();
  if (!content) {
    throw new ApiError(400, 'Message is required');
  }
  if (content.length > 2000) {
    throw new ApiError(400, 'Message is too long');
  }

  let store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  if (!canServeChatbot(store, { demoMode: options.demoMode })) {
    throw new ApiError(402, 'Chatbot is unavailable for this store');
  }

  const compliance = getComplianceMessages(store);
  const { legalAge, ageQuestion, lockMessage } = compliance;

  let session = await ChatSession.findOne({ sessionKey, storeId });
  if (!session) {
    session = await ChatSession.create({
      sessionKey: sessionKey || crypto.randomUUID(),
      storeId,
      ageVerified: false,
      locked: false,
      funnelState: {
        phase: 'age',
        currentStepId: null,
        candidateProductIds: [],
        path: [],
      },
      messages: [{ role: 'assistant', content: ageQuestion }],
      lastMessageAt: new Date(),
    });
  }

  if (session.locked) {
    return {
      ...serializeSession(session, store, compliance),
      reply: lockMessage,
      replyType: 'locked',
      options: [],
      products: [],
      locked: true,
    };
  }

  if (detectsUnderage(content, legalAge)) {
    return lockSession(session, store, compliance, content, 'underage_tripwire');
  }

  // Restart recommendation funnel
  if (session.ageVerified && detectsRecommendationRestart(content)) {
    store = (await ensureStoreTaxonomy(store._id)) || store;
    session.messages.push({ role: 'user', content });
    const started = await resetFunnel(store, session);
    session.messages.push({ role: 'assistant', content: started.reply });
    session.lastMessageAt = new Date();
    await session.save();
    return {
      ...serializeSession(session, store, compliance),
      ...started,
      locked: false,
      recommendationRestart: true,
    };
  }

  // Age verification gate
  if (!session.ageVerified) {
    const ageReply = interpretAgeReply(content, legalAge);
    session.messages.push({ role: 'user', content });

    if (ageReply === 'no') {
      return lockSession(session, store, compliance, null, 'age_denied');
    }

    if (ageReply === 'unclear') {
      const reply = `Please confirm: ${ageQuestion}`;
      session.messages.push({ role: 'assistant', content: reply });
      session.lastMessageAt = new Date();
      await session.save();
      return {
        ...serializeSession(session, store, compliance),
        reply,
        replyType: 'age',
        options: [],
        products: [],
        locked: false,
      };
    }

    session.ageVerified = true;
    store = (await ensureStoreTaxonomy(store._id)) || store;
    const started = await beginFunnel(store, session);
    session.messages.push({ role: 'assistant', content: started.reply });
    session.lastMessageAt = new Date();
    await session.save();

    return {
      ...serializeSession(session, store, compliance),
      ...started,
      locked: false,
    };
  }

  session.messages.push({ role: 'user', content });

  const inventory = await getRecommendableInventory(store._id);
  if (!inventory.length) {
    const reply =
      "I don't have any products available to recommend right now. Please check back later.";
    session.messages.push({ role: 'assistant', content: reply });
    session.lastMessageAt = new Date();
    await session.save();
    return {
      ...serializeSession(session, store, compliance),
      reply,
      replyType: 'text',
      options: [],
      products: [],
      locked: false,
    };
  }

  store = (await ensureStoreTaxonomy(store._id)) || store;

  const phase = session.funnelState?.phase || 'funnel';
  let guided = null;

  if (phase === 'funnel' || phase === 'recommendation') {
    guided = await advanceFunnel(store, session, content, inventory);
  }

  if (guided) {
    session.messages.push({ role: 'assistant', content: guided.reply });
    session.lastMessageAt = new Date();
    await session.save();
    return {
      ...serializeSession(session, store, compliance),
      ...guided,
      locked: false,
    };
  }

  // Free-form chat fallback (taxonomy missing or free_chat phase)
  let reply = await generateAssistantReply(store, session, inventory, content);

  if (reply.includes('This conversation has ended')) {
    session.locked = true;
    session.lockReason = 'model_underage_detection';
    reply = lockMessage;
  } else {
    reply = enforceInventoryOnlyReply(reply, inventory, content);
  }

  session.funnelState = {
    ...(session.funnelState || {}),
    phase: session.locked ? 'age' : 'free_chat',
  };
  session.messages.push({ role: 'assistant', content: reply });
  session.lastMessageAt = new Date();
  await session.save();

  // Extend response with storefront product URLs for View Product CTA (no cart / checkout)
  let replyType = session.locked ? 'locked' : 'text';
  let products = [];
  if (!session.locked) {
    const mentioned = inventory.filter((p) => isProductReferencedInReply(p, reply));
    const looksLikeRecommendation =
      /\b(try|recommend|like|suggest|option|available|inventory|flavor|might|enjoy|check out)\b/i.test(
        reply
      );
    if (looksLikeRecommendation && mentioned.length) {
      replyType = 'recommendation';
      products = mentioned.slice(0, 1).map(serializeProductCard).filter(Boolean);
    }
  }

  return {
    ...serializeSession(session, store, compliance),
    reply,
    replyType,
    options: session.locked
      ? []
      : [
          {
            id: 'another',
            label: 'Get Another Recommendation',
            emoji: '✨',
            value: 'Get Another Recommendation',
          },
        ],
    products,
    locked: session.locked,
  };
}

async function lockSession(session, store, compliance, userContent, reason) {
  const { lockMessage } = compliance;

  if (userContent) {
    session.messages.push({ role: 'user', content: userContent });
  }
  session.locked = true;
  session.lockReason = reason;
  session.messages.push({ role: 'assistant', content: lockMessage });
  session.lastMessageAt = new Date();
  await session.save();

  return {
    ...serializeSession(session, store, compliance),
    reply: lockMessage,
    replyType: 'locked',
    options: [],
    products: [],
    locked: true,
  };
}

async function generateAssistantReply(store, session, inventory, userMessage) {
  if (!env.openai.apiKey) {
    return buildInventoryFallbackReply(inventory, userMessage);
  }

  const inventoryText = formatInventoryForPrompt(inventory);
  const legalAge = resolveStoreLegalAge(store);
  const systemPrompt = buildSystemPrompt(store.name, inventoryText, legalAge);

  const history = session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.openai.model,
        temperature: 0.2,
        max_tokens: 320,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('[assistant] OpenAI error:', response.status, errBody.slice(0, 300));
      return buildInventoryFallbackReply(inventory, userMessage);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return buildInventoryFallbackReply(inventory, userMessage);

    return enforceResponseLength(text);
  } catch (error) {
    console.error('[assistant] OpenAI request failed:', error.message);
    return buildInventoryFallbackReply(inventory, userMessage);
  }
}

function enforceInventoryOnlyReply(reply, inventory, userMessage) {
  if (!reply || !inventory?.length) {
    return buildInventoryFallbackReply(inventory, userMessage);
  }

  const mentioned = inventory.filter((p) => isProductReferencedInReply(p, reply));

  const looksLikeRecommendation =
    /\b(try|recommend|like|suggest|option|available|inventory|flavor|might|enjoy|check out)\b/i.test(
      reply
    );

  if (looksLikeRecommendation && mentioned.length === 0) {
    console.warn('[assistant] Reply did not reference inventory — using keyword fallback');
    return buildInventoryFallbackReply(inventory, userMessage);
  }

  return reply;
}

function enforceResponseLength(text) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  if (sentences.length <= 3) return text.trim();
  return sentences.slice(0, 3).join(' ').trim();
}

function serializeSession(session, store, compliance, extras = {}) {
  return {
    sessionKey: session.sessionKey,
    storeId: store._id,
    storeName: store.name,
    legalAge: compliance.legalAge,
    regionLabel: compliance.regionLabel,
    minimumAgeLabel: `Minimum Age: ${compliance.legalAge}+`,
    ageVerified: session.ageVerified,
    locked: session.locked,
    healthWarning: compliance.healthWarning,
    ageQuestion: compliance.ageQuestion,
    ageYesLabel: getAgeYesLabel(compliance.legalAge),
    lockMessage: compliance.lockMessage,
    poweredBy: 'Powered by VapePass',
    funnelState: session.funnelState || null,
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    ...extras,
  };
}
