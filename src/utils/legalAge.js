/**
 * Legal purchasing age by store location (US + Canada).
 * Single source of truth — used by Store model, compliance layer, and chatbot.
 */

const US_COUNTRY_VALUES = new Set([
  'US',
  'USA',
  'U.S.',
  'U.S.A.',
  'UNITED STATES',
  'UNITED STATES OF AMERICA',
]);

const CANADA_COUNTRY_VALUES = new Set(['CA', 'CAN', 'CANADA']);

/** Provinces/territories where the legal age is 19 */
const CANADA_AGE_19 = new Set([
  'BC',
  'BRITISH COLUMBIA',
  'ON',
  'ONTARIO',
  'SK',
  'SASKATCHEWAN',
  'NS',
  'NOVA SCOTIA',
  'NB',
  'NEW BRUNSWICK',
  'NL',
  'NEWFOUNDLAND AND LABRADOR',
  'NEWFOUNDLAND',
  'NT',
  'NORTHWEST TERRITORIES',
  'NU',
  'NUNAVUT',
  'YT',
  'YUKON',
  'YUKON TERRITORY',
]);

/** Provinces where the legal age is 18 */
const CANADA_AGE_18 = new Set([
  'AB',
  'ALBERTA',
  'MB',
  'MANITOBA',
  'QC',
  'QUEBEC',
  'QUÉBEC',
]);

/** Province where the legal age is 21 */
const CANADA_AGE_21 = new Set(['PE', 'PRINCE EDWARD ISLAND']);

/** Default when country is Canada but province is missing (legacy BC-focused default). */
export const DEFAULT_LEGAL_AGE = 19;

/**
 * Normalize a country string to 'US', 'CA', or the uppercased raw value.
 */
export function normalizeCountry(country) {
  if (!country) return 'CA';
  const normalized = String(country).trim().toUpperCase();
  if (US_COUNTRY_VALUES.has(normalized)) return 'US';
  if (CANADA_COUNTRY_VALUES.has(normalized)) return 'CA';
  return normalized;
}

/**
 * Normalize province/state to a comparable uppercase token.
 */
export function normalizeProvince(province) {
  if (!province) return null;
  return String(province)
    .trim()
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Determine the legal purchasing age from country and province/state.
 * @param {string|null|undefined} country
 * @param {string|null|undefined} province
 * @returns {number}
 */
export function getLegalAge(country, province) {
  const normalizedCountry = normalizeCountry(country);

  if (normalizedCountry === 'US') {
    return 21;
  }

  if (normalizedCountry === 'CA') {
    const prov = normalizeProvince(province);
    if (!prov) return DEFAULT_LEGAL_AGE;
    if (CANADA_AGE_21.has(prov)) return 21;
    if (CANADA_AGE_18.has(prov)) return 18;
    if (CANADA_AGE_19.has(prov)) return 19;
    return DEFAULT_LEGAL_AGE;
  }

  return DEFAULT_LEGAL_AGE;
}

/**
 * Resolve legal age from a store document (always derived from location fields).
 */
export function resolveStoreLegalAge(store) {
  if (!store) return DEFAULT_LEGAL_AGE;
  return getLegalAge(store.country, store.province);
}

/**
 * Human-readable region label for compliance copy.
 */
export function getRegionLabel(country, province) {
  const normalizedCountry = normalizeCountry(country);
  if (normalizedCountry === 'US') return 'the United States';
  const prov = normalizeProvince(province);
  if (prov) return prov;
  return 'this location';
}

/**
 * Age verification question shown at the start of a chat session.
 */
export function getAgeQuestion(legalAge) {
  return `Are you ${legalAge} years of age or older?`;
}

/**
 * Message displayed when a session is locked for underage access.
 */
export function getLockMessage(legalAge, country, province) {
  const region = getRegionLabel(country, province);
  return `VapePass Assistant is only available to persons ${legalAge} years of age or older in ${region}. This conversation has ended.`;
}

/**
 * Nicotine health warning with the store's legal age.
 */
export function getHealthWarning(legalAge) {
  return `WARNING: Vaping products contain nicotine. Nicotine is highly addictive. For use by persons ${legalAge} years of age or older only.`;
}

/**
 * Affirmative button label for age verification UIs.
 */
export function getAgeYesLabel(legalAge) {
  return `Yes, I'm ${legalAge}+`;
}
