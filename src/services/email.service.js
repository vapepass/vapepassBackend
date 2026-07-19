import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import {
  buildPaymentFailedEmail,
  buildRenewalReminderEmail,
  buildSetupRequestAdminEmail,
  buildSetupRequestCustomerEmail,
  buildSubscriptionActivatedEmail,
  buildSubscriptionPausedEmail,
} from '../utils/emailTemplates.js';

let transporter = null;
let fromAddressLogged = false;
let configLogged = false;

function extractEmailAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function hasResend() {
  return Boolean(env.email.resendApiKey);
}

function hasSmtp() {
  return Boolean(env.email.host && env.email.user && env.email.pass);
}

/**
 * Prefer Resend From, then EMAIL_FROM, then SMTP user.
 * Gmail SMTP requires From === authenticated user.
 */
function resolveFromAddress() {
  const configuredFrom = String(env.email.from || '').trim();
  const smtpUser = String(env.email.user || '').trim();

  if (hasResend()) {
    // Resend: use verified domain From, or onboarding@resend.dev for testing
    return configuredFrom || 'VapePass <onboarding@resend.dev>';
  }

  if (!configuredFrom && smtpUser) {
    return `VapePass <${smtpUser}>`;
  }

  if (configuredFrom && smtpUser) {
    const fromEmail = extractEmailAddress(configuredFrom);
    const userEmail = extractEmailAddress(smtpUser);
    if (fromEmail && userEmail && fromEmail !== userEmail) {
      if (!fromAddressLogged) {
        console.warn(
          `[email] EMAIL_FROM (${fromEmail}) differs from SMTP_USER (${userEmail}). ` +
            'Using SMTP_USER as From to avoid provider rejection (common with Gmail).'
        );
        fromAddressLogged = true;
      }
      return `VapePass <${smtpUser}>`;
    }
  }

  return configuredFrom || (smtpUser ? `VapePass <${smtpUser}>` : undefined);
}

function getTransporter() {
  const from = resolveFromAddress();
  if (!hasSmtp() || !from) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.secure,
      auth: { user: env.email.user, pass: env.email.pass },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  return transporter;
}

export function isEmailConfigured() {
  return hasResend() || (hasSmtp() && Boolean(resolveFromAddress()));
}

export function getEmailProvider() {
  if (hasResend()) return 'resend';
  if (hasSmtp()) return 'smtp';
  return 'none';
}

export function getSupportAdminEmail() {
  return String(env.email.supportAdmin || '').trim();
}

/** Log email readiness once at boot (no secrets). */
export function logEmailConfigStatus() {
  if (configLogged) return;
  configLogged = true;

  const provider = getEmailProvider();
  const admin = getSupportAdminEmail();
  const testingTo = env.email.resendTestingTo;

  console.info(
    `[email] provider=${provider} — ` +
      `from=${resolveFromAddress() || 'n/a'}, ` +
      `supportAdmin=${admin || 'MISSING (set SUPPORT_ADMIN_EMAIL)'}` +
      (testingTo ? `, testingRedirect=${testingTo}` : '') +
      (provider === 'smtp'
        ? `, host=${env.email.host}, port=${env.email.port}, user=${env.email.user}`
        : '')
  );

  if (provider === 'none') {
    console.warn(
      '[email] No email provider configured. Set RESEND_API_KEY (recommended on Railway) ' +
        'or SMTP_HOST/SMTP_USER/SMTP_PASS.'
    );
  }

  if (provider === 'smtp' && env.nodeEnv === 'production') {
    console.warn(
      '[email] Using SMTP in production. Railway often blocks Gmail port 587 (Connection timeout). ' +
        'Prefer RESEND_API_KEY (HTTPS) for reliable delivery.'
    );
  }

  if (provider === 'resend' && !testingTo) {
    console.warn(
      '[email] Without a verified Resend domain, you can only send to your Resend account email. ' +
        'Set RESEND_TESTING_TO to that exact address (see Resend error message), or verify a domain at resend.com/domains.'
    );
  }

  if (!admin) {
    console.warn(
      '[email] SUPPORT_ADMIN_EMAIL is not set — Free Setup admin notifications will be skipped.'
    );
  }
}

/**
 * Resend free/test accounts can only deliver to the account owner email until a
 * domain is verified. Optionally redirect every message to that inbox.
 */
function applyResendTestingRedirect({ to, subject, text, html }, forceTo = null) {
  const testingTo = String(forceTo || env.email.resendTestingTo || '')
    .trim()
    .toLowerCase();
  if (!hasResend() || !testingTo) {
    return { to, subject, text, html, redirected: false };
  }

  if (extractEmailAddress(to) === testingTo) {
    return { to: testingTo, subject, text, html, redirected: false };
  }

  const safeTo = String(to).replace(/</g, '&lt;');
  const banner = `
    <p style="margin:0 0 20px;padding:12px 14px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;font-size:13px;color:#5b21b6;line-height:1.5;">
      <strong>Resend test mode</strong><br/>
      Intended recipient: ${safeTo}
    </p>
  `;

  return {
    to: testingTo,
    subject: `[→ ${to}] ${subject}`,
    text: `${text}\n\n---\n[Resend test mode] Intended recipient: ${to}\n`,
    html: `${banner}${html || ''}`,
    redirected: true,
  };
}

/** Parse "your own email address (user@gmail.com)" from Resend errors. */
function extractResendAllowedEmail(errorMessage) {
  const match = String(errorMessage || '').match(
    /your own email address\s*\(([^)]+@[^)]+)\)/i
  );
  return match ? match[1].trim().toLowerCase() : '';
}

async function sendViaResend({ to, subject, text, html, replyTo, from }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.email.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || data?.error || `Resend HTTP ${response.status}`;
    throw new Error(message);
  }

  return { sent: true, messageId: data?.id, provider: 'resend' };
}

async function sendViaSmtp({ to, subject, text, html, replyTo, from }) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP transport not available');
  }

  const info = await transport.sendMail({
    from,
    to,
    replyTo: replyTo || undefined,
    subject,
    text,
    html,
  });

  return { sent: true, messageId: info?.messageId, provider: 'smtp' };
}

async function sendMail({ to, subject, text, html, replyTo }) {
  const from = resolveFromAddress();
  const provider = getEmailProvider();

  if (provider === 'none' || !from) {
    console.warn(`[email] No provider configured. Would send to ${to}: ${subject}`);
    console.warn(text);
    return { sent: false, devFallback: true };
  }

  if (!to) {
    console.error(`[email] Missing recipient for: ${subject}`);
    return { sent: false, error: 'Missing recipient' };
  }

  let delivery =
    provider === 'resend'
      ? applyResendTestingRedirect({ to, subject, text, html })
      : { to, subject, text, html, redirected: false };

  const attemptSend = async (payload) => {
    if (provider === 'resend') {
      return sendViaResend({
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        replyTo,
        from,
      });
    }
    return sendViaSmtp({ to, subject, text, html, replyTo, from });
  };

  try {
    const result = await attemptSend(delivery);

    console.info(
      `[email] Sent via ${result.provider} "${delivery.subject}" → ${delivery.to}` +
        (delivery.redirected ? ` (redirected from ${to})` : '') +
        (result.messageId ? ` (id: ${result.messageId})` : '')
    );

    return result;
  } catch (error) {
    const msg = error.message || String(error);

    // Auto-recover from Resend test-mode restriction by retrying to the allowed inbox.
    if (provider === 'resend' && /only send testing emails|verify a domain/i.test(msg)) {
      const allowed = extractResendAllowedEmail(msg);
      if (allowed && extractEmailAddress(delivery.to) !== allowed) {
        console.warn(
          `[email] Resend only allows ${allowed} until a domain is verified. ` +
            `Retrying (set RESEND_TESTING_TO=${allowed} on Railway to skip this retry).`
        );
        delivery = applyResendTestingRedirect({ to, subject, text, html }, allowed);
        try {
          const retry = await attemptSend(delivery);
          console.info(
            `[email] Sent via ${retry.provider} "${delivery.subject}" → ${delivery.to}` +
              ` (auto-redirected from ${to})` +
              (retry.messageId ? ` (id: ${retry.messageId})` : '')
          );
          return retry;
        } catch (retryError) {
          console.error(
            `[email] sendMail retry failed → ${delivery.to}:`,
            retryError.message || retryError
          );
          return { sent: false, error: retryError.message || String(retryError) };
        }
      }
    }

    console.error(
      `[email] sendMail failed via ${provider} → ${delivery.to} ("${delivery.subject}"):`,
      msg
    );

    if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg) && provider === 'smtp') {
      console.error(
        '[email] SMTP connection timed out. Railway commonly blocks outbound Gmail SMTP. ' +
          'Add RESEND_API_KEY on Railway and redeploy (HTTPS email works).'
      );
    }

    if (/only send testing emails|verify a domain/i.test(msg)) {
      const allowed = extractResendAllowedEmail(msg) || 'your Resend account email';
      console.error(
        `[email] Resend test restriction: set RESEND_TESTING_TO=${allowed} and SUPPORT_ADMIN_EMAIL=${allowed}, ` +
          'or verify your domain at https://resend.com/domains and update EMAIL_FROM.'
      );
    }

    return { sent: false, error: msg };
  }
}

/**
 * Sends password reset email. In development without a provider, logs the link.
 * Never throws — callers should treat forgot-password as always successful.
 */
export async function sendPasswordResetEmail(to, resetToken) {
  const resetUrl = `${env.clientUrl.replace(/\/+$/, '')}/reset-password?token=${resetToken}`;

  if (!isEmailConfigured()) {
    console.warn(`[email] No provider configured. Password reset link for ${to}: ${resetUrl}`);
    return { sent: false, devFallback: true };
  }

  return sendMail({
    to,
    subject: 'Reset your VapePass password',
    text: [
      'You requested a password reset for your VapePass account.',
      '',
      `Reset your password: ${resetUrl}`,
      '',
      'This link expires in 1 hour. If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#0c0c12;margin:0 0 12px;">Reset your password</h2>
        <p style="color:#5c5c6d;line-height:1.6;">You requested a password reset for your VapePass account. Click the button below to choose a new password.</p>
        <p style="margin:24px 0;">
          <a href="${resetUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-weight:600;">Reset password</a>
        </p>
        <p style="color:#9494a6;font-size:13px;line-height:1.5;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendSubscriptionActivatedEmail(to, payload) {
  const email = buildSubscriptionActivatedEmail(payload);
  return sendMail({ to, ...email });
}

export async function sendRenewalReminderEmail(to, payload) {
  const email = buildRenewalReminderEmail(payload);
  return sendMail({ to, ...email });
}

export async function sendPaymentFailedEmail(to, payload) {
  const email = buildPaymentFailedEmail(payload);
  return sendMail({ to, ...email });
}

export async function sendSubscriptionPausedEmail(to, payload) {
  const email = buildSubscriptionPausedEmail(payload);
  return sendMail({ to, ...email });
}

export async function sendSetupRequestCustomerEmail(to, payload) {
  const email = buildSetupRequestCustomerEmail(payload);
  return sendMail({ to, ...email });
}

export async function sendSetupRequestAdminEmail(to, payload) {
  const email = buildSetupRequestAdminEmail(payload);
  console.info(`[email] Sending admin setup notification → ${to}`);
  return sendMail({
    to,
    ...email,
    replyTo: payload.email || undefined,
  });
}
