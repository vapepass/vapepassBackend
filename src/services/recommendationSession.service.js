/**
 * Recommendation session manager.
 * Isolates each recommendation "pass" so prefs from a completed recommendation
 * never leak into a brand-new shopping request — while still allowing refine.
 */

import { foldText, sanitizeUserHint } from '../utils/nlu.js';
import {
  emptyPreferences,
  extractShoppingPreferences,
} from './preferenceConversation.service.js';

/** Explicit: user wants a brand-new recommendation pass */
const NEW_PASS_RE =
  /\b(another recomm\w*|new recomm\w*|get another recomm\w*|recommend (something else|another (product|vape|one)|again)|something (else|completely different)|start (over|again|fresh)|let'?s start (over|again|fresh)|different product|show me another product|recommend another vape|for my friend|completely different|i want (another|a different) recomm\w*)\b/i;

/** Explicit: user is tweaking the current recommendation */
const REFINE_PASS_RE =
  /\b(more ice|less ice|extra ice|heavy ice|strong(?:er)? ice|less cooling|more cooling|icier|sweeter|less sweet|more sweet|smoother|milder|stronger(?: nicotine)?|more (?:fruity|tropical|citrus|candy|menthol|mint|dessert|berry)|fruitier|candy[- ]?like|another (flavor|variant|option)|different (flavor|variant|option)|something similar|similar (one|product|option)|same (kind|type|style|vibe)|don'?t like (this|that|the) flavor|i don'?t like this|not this flavor|make it (sweeter|icier|cooler|less sweet|less icy|more fruity)|another option for (this|that)|suggest another (variant|option|flavor)|stronger nicotine|more nicotine)\b/i;

/**
 * Classify whether the user wants a new recommendation pass, a refine, or to continue collecting.
 * @returns {'new'|'refine'|'continue'}
 */
export function classifyRecommendationIntent(message, context = {}) {
  const phase = context.phase || null;
  const preferences = context.preferences || null;
  const clean = sanitizeUserHint(message);
  const text = foldText(clean);
  if (!text) return 'continue';

  const extracted = extractShoppingPreferences(clean);
  const afterRecommendation = phase === 'recommendation' || phase === 'free_chat';
  const hasRefineSignal = REFINE_PASS_RE.test(text);
  const hasNewSignal = NEW_PASS_RE.test(text) || detectsSoftRecommendationRestart(text);

  // "another recommendation" / start over always opens a new pass
  if (hasNewSignal && !isPureRefineWithoutRestart(text, hasRefineSignal, hasNewSignal)) {
    return 'new';
  }

  // Relative tweaks to the current pick
  if (hasRefineSignal && !hasNewSignal) {
    return 'refine';
  }

  // After a card: "no ice" / "with ice" alone is a refine of the current pass
  if (
    afterRecommendation &&
    !hasNewSignal &&
    /\b(no ice|without ice|with ice|extra ice|heavy ice)\b/i.test(text) &&
    !extracted.productType
  ) {
    return 'refine';
  }

  // After a card was shown: naming a product type (especially a different one) = new pass
  if (afterRecommendation && extracted.productType) {
    if (!preferences?.productType || preferences.productType !== extracted.productType) {
      return 'new';
    }
    // Same type but a fresh shopping statement ("another fruity disposable")
    if (extracted.flavorDirection || extracted.specificFlavors?.length || extracted.cooling) {
      return 'new';
    }
  }

  // After a card: any clear shopping statement that isn't a refine = new pass
  if (
    afterRecommendation &&
    !hasRefineSignal &&
    (extracted.productType ||
      extracted.flavorDirection ||
      (extracted.specificFlavors && extracted.specificFlavors.length) ||
      extracted.cooling ||
      extracted.sweetness)
  ) {
    return 'new';
  }

  // Mid-collection: switching product type abandons the previous pass
  if (
    (phase === 'prefer' || phase === 'preference') &&
    preferences?.productType &&
    extracted.productType &&
    preferences.productType !== extracted.productType
  ) {
    return 'new';
  }

  return 'continue';
}

function isPureRefineWithoutRestart(text, hasRefine, hasNew) {
  // If both match, prefer NEW when restart language is present
  if (hasNew) return false;
  return hasRefine;
}

/** Broader than legacy detectsRecommendationRestart — used for soft new-pass detection */
export function detectsSoftRecommendationRestart(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (
    /\b(another recommendation|different (flavor|recommendation|one|product)|something else|start over|new recommendation|recommend (again|something else))\b/i.test(
      t
    ) ||
    /\bi want (another|a different|something else)\b/i.test(t) ||
    /\bget another recommendation\b/i.test(t) ||
    /\b(show me|i want|looking for|recommend)\s+(a |an )?(completely )?different\b/i.test(t) ||
    /\bnow i want\b/i.test(t) ||
    /\bfor my friend\b/i.test(t)
  );
}

/**
 * Empty isolated recommendation context (does not touch chat message history).
 */
export function emptyRecommendationContext() {
  return {
    preferences: emptyPreferences(),
    preferenceHints: [],
    path: [],
    candidateProductIds: [],
    parentExternalId: null,
    variantPath: [],
    lastAsked: null,
    askAttempts: {},
    lastAskText: null,
    currentStepId: null,
  };
}

/**
 * Reset recommendation memory on the session while keeping phase in prefer mode.
 * Optionally seed with prefs extracted from the triggering message.
 * Keeps excludedProductIds so we don't re-serve the same cards.
 */
export function resetRecommendationContext(session, { seedPreferences = null, phase = 'prefer' } = {}) {
  const empty = emptyRecommendationContext();
  const preferences = seedPreferences
    ? {
        ...emptyPreferences(),
        ...seedPreferences,
        specificFlavors: [...(seedPreferences.specificFlavors || [])],
        rawHints: [...(seedPreferences.rawHints || [])],
      }
    : emptyPreferences();

  const priorExcluded = session.funnelState?.excludedProductIds || [];

  session.funnelState = {
    phase,
    ...empty,
    preferences,
    preferenceHints: preferences.rawHints || [],
    excludedProductIds: [...priorExcluded],
  };

  return session.funnelState;
}

/**
 * True when the message is mainly "start over / another recommendation"
 * without enough shopping detail to jump straight into filtering.
 */
export function isBareRecommendationRestart(message) {
  const extracted = extractShoppingPreferences(message);
  const hasDetail =
    Boolean(extracted.productType) ||
    Boolean(extracted.flavorDirection) ||
    (extracted.specificFlavors && extracted.specificFlavors.length > 0);
  // Cooling alone (e.g. "another product with no ice") is not enough to recommend
  return !hasDetail;
}
