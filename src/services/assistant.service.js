import crypto from 'crypto';
import Store from '../models/Store.js';
import ChatSession from '../models/ChatSession.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';
import {
  buildSystemPrompt,
  detectsUnderage,
  formatInventoryForPrompt,
  getComplianceMessages,
  interpretAgeReply,
  isProductReferencedInReply,
  buildInventoryFallbackReply,
} from '../utils/compliance.js';
import { getAgeYesLabel, resolveStoreLegalAge } from '../utils/legalAge.js';
import { getRecommendableInventory } from './inventory.service.js';

const MAX_HISTORY_MESSAGES = 20;

/**
 * Public widget bootstrap config for a store.
 */
export async function getWidgetConfig(storeId) {
  const store = await Store.findById(storeId).select(
    'name brandColor assistantEnabled productPageUrl country province legalAge'
  );
  if (!store) {
    throw new ApiError(404, 'Store not found');
  }

  const inventory = await getRecommendableInventory(store._id);
  const compliance = getComplianceMessages(store);

  return {
    storeId: store._id,
    storeName: store.name,
    brandColor: store.brandColor,
    legalAge: compliance.legalAge,
    healthWarning: compliance.healthWarning,
    ageQuestion: compliance.ageQuestion,
    ageYesLabel: getAgeYesLabel(compliance.legalAge),
    lockMessage: compliance.lockMessage,
    requireSiteAgeGate: true,
    enabled: Boolean(store.assistantEnabled && store.productPageUrl && inventory.length > 0),
    productCount: inventory.length,
  };
}

/**
 * Start or resume a chat session. Returns the opening age-verification prompt when new.
 */
export async function startSession(storeId, sessionKey) {
  const store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
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
 * Process a customer message with full compliance + inventory-only enforcement.
 */
export async function sendMessage(storeId, sessionKey, message) {
  const content = String(message || '').trim();
  if (!content) {
    throw new ApiError(400, 'Message is required');
  }
  if (content.length > 2000) {
    throw new ApiError(400, 'Message is too long');
  }

  const store = await Store.findById(storeId);
  if (!store) {
    throw new ApiError(404, 'Store not found');
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
      messages: [{ role: 'assistant', content: ageQuestion }],
      lastMessageAt: new Date(),
    });
  }

  // Permanently locked sessions cannot continue
  if (session.locked) {
    return {
      ...serializeSession(session, store, compliance),
      reply: lockMessage,
      locked: true,
    };
  }

  // Hardcoded underage tripwire — runs before any model call
  if (detectsUnderage(content, legalAge)) {
    return lockSession(session, store, compliance, content, 'underage_tripwire');
  }

  // Chatbot age verification gate (step 2 of double age verification)
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
        locked: false,
      };
    }

    session.ageVerified = true;
    const welcome =
      "Thanks for confirming. Tell me what you usually get or what you're looking for, and I'll recommend options from our current inventory only.";
    session.messages.push({ role: 'assistant', content: welcome });
    session.lastMessageAt = new Date();
    await session.save();

    return {
      ...serializeSession(session, store, compliance),
      reply: welcome,
      locked: false,
    };
  }

  session.messages.push({ role: 'user', content });

  // Always load recommendations dynamically from this retailer's MongoDB inventory
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
      locked: false,
    };
  }

  let reply = await generateAssistantReply(store, session, inventory, content);

  // Secondary compliance check on model output for underage lock phrasing
  if (reply.includes('This conversation has ended')) {
    session.locked = true;
    session.lockReason = 'model_underage_detection';
    reply = lockMessage;
  } else {
    // Enforce inventory-only: never allow hallucinated product names through
    reply = enforceInventoryOnlyReply(reply, inventory, content);
  }

  session.messages.push({ role: 'assistant', content: reply });
  session.lastMessageAt = new Date();
  await session.save();

  return {
    ...serializeSession(session, store, compliance),
    reply,
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
        max_tokens: 220,
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

/**
 * If the model mentions products not in inventory, replace with a keyword-matched fallback.
 */
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

function serializeSession(session, store, compliance) {
  return {
    sessionKey: session.sessionKey,
    storeId: store._id,
    storeName: store.name,
    legalAge: compliance.legalAge,
    ageVerified: session.ageVerified,
    locked: session.locked,
    healthWarning: compliance.healthWarning,
    ageQuestion: compliance.ageQuestion,
    ageYesLabel: getAgeYesLabel(compliance.legalAge),
    lockMessage: compliance.lockMessage,
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  };
}
