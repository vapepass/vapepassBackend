import crypto from 'crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/constants.js';

/**
 * PassKit integration service.
 * When credentials are configured, replace stubs with real PassKit API calls.
 * @see https://docs.passkit.io/
 */

const isConfigured = () =>
  Boolean(env.passkit.apiKey && env.passkit.apiSecret);

export const syncStoreProgram = async (store) => {
  if (!isConfigured()) {
    console.warn('PassKit not configured — skipping program sync for store', store._id);
    return { programId: store.passKitProgramId, templateId: store.passKitTemplateId };
  }

  // TODO: PassKit API — create/update loyalty program template with store branding
  return { programId: store.passKitProgramId, templateId: store.passKitTemplateId };
};

export const issuePass = async (store, customer) => {
  const qrPayload = `vapepass:${customer.passIdentifier}`;

  if (!isConfigured()) {
    const base = `${env.clientUrl}/customer-card?id=${customer._id}`;
    return {
      memberId: null,
      appleWalletUrl: base,
      googleWalletUrl: base,
      qrPayload,
    };
  }

  // TODO: PassKit API — enroll member and return wallet URLs with QR on pass face
  const base = `${env.clientUrl}/customer-card?id=${customer._id}`;
  return {
    memberId: `pk_${customer.passIdentifier.slice(0, 8)}`,
    appleWalletUrl: base,
    googleWalletUrl: base,
    qrPayload,
  };
};

export const updatePassStamps = async (store, customer) => {
  if (!isConfigured()) return;

  // TODO: PassKit API — push stamp count update to customer's wallet pass
  void store;
  void customer;
};

export const notifyTwoStampsAway = async (store, customer) => {
  if (!isConfigured()) return;

  // TODO: PassKit API — send lock screen notification (2 stamps from reward)
  void store;
  void customer;
};

export const notifyRewardReady = async (store, customer) => {
  if (!isConfigured()) return;

  // TODO: PassKit API — update pass visual + lock screen notification
  void store;
  void customer;
};

export const generatePassIdentifier = () => crypto.randomUUID();
