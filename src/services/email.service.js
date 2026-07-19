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

function extractEmailAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

/**
 * Gmail (and many SMTP providers) reject messages when From ≠ authenticated user.
 * Prefer SMTP_USER as the envelope From when EMAIL_FROM uses a different address.
 */
function resolveFromAddress() {
  const configuredFrom = String(env.email.from || '').trim();
  const smtpUser = String(env.email.user || '').trim();

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

  return configuredFrom || smtpUser || undefined;
}

function getTransporter() {
  const from = resolveFromAddress();
  if (!env.email.host || !from) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.secure,
      auth:
        env.email.user && env.email.pass
          ? { user: env.email.user, pass: env.email.pass }
          : undefined,
    });
  }

  return transporter;
}

export function isEmailConfigured() {
  return Boolean(env.email.host && resolveFromAddress());
}

export function getSupportAdminEmail() {
  return String(env.email.supportAdmin || '').trim();
}

async function sendMail({ to, subject, text, html, replyTo }) {
  const transport = getTransporter();
  const from = resolveFromAddress();

  if (!transport || !from) {
    console.warn(`[email] SMTP not configured. Would send to ${to}: ${subject}`);
    console.warn(text);
    return { sent: false, devFallback: true };
  }

  if (!to) {
    console.error(`[email] Missing recipient for: ${subject}`);
    return { sent: false, error: 'Missing recipient' };
  }

  const info = await transport.sendMail({
    from,
    to,
    replyTo: replyTo || undefined,
    subject,
    text,
    html,
  });

  console.info(
    `[email] Sent "${subject}" → ${to}` +
      (info?.messageId ? ` (id: ${info.messageId})` : '')
  );

  return { sent: true, messageId: info?.messageId };
}

/**
 * Sends password reset email. In development without SMTP, logs the link.
 * Never throws — callers should treat forgot-password as always successful.
 */
export async function sendPasswordResetEmail(to, resetToken) {
  const resetUrl = `${env.clientUrl.replace(/\/+$/, '')}/reset-password?token=${resetToken}`;
  const transport = getTransporter();
  const from = resolveFromAddress();

  if (!transport || !from) {
    console.warn(`[email] SMTP not configured. Password reset link for ${to}: ${resetUrl}`);
    return { sent: false, devFallback: true };
  }

  try {
    return await sendMail({
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
  } catch (error) {
    console.error(`[email] Failed password reset email to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}

export async function sendSubscriptionActivatedEmail(to, payload) {
  const email = buildSubscriptionActivatedEmail(payload);
  try {
    return await sendMail({ to, ...email });
  } catch (error) {
    console.error(`[email] Failed subscription activated email to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}

export async function sendRenewalReminderEmail(to, payload) {
  const email = buildRenewalReminderEmail(payload);
  try {
    return await sendMail({ to, ...email });
  } catch (error) {
    console.error(`[email] Failed renewal reminder to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}

export async function sendPaymentFailedEmail(to, payload) {
  const email = buildPaymentFailedEmail(payload);
  try {
    return await sendMail({ to, ...email });
  } catch (error) {
    console.error(`[email] Failed payment-failed email to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}

export async function sendSubscriptionPausedEmail(to, payload) {
  const email = buildSubscriptionPausedEmail(payload);
  try {
    return await sendMail({ to, ...email });
  } catch (error) {
    console.error(`[email] Failed subscription paused email to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}

export async function sendSetupRequestCustomerEmail(to, payload) {
  const email = buildSetupRequestCustomerEmail(payload);
  try {
    return await sendMail({ to, ...email });
  } catch (error) {
    console.error(`[email] Failed setup-request customer email to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}

export async function sendSetupRequestAdminEmail(to, payload) {
  const email = buildSetupRequestAdminEmail(payload);
  try {
    console.info(`[email] Sending admin setup notification → ${to}`);
    return await sendMail({
      to,
      ...email,
      replyTo: payload.email || undefined,
    });
  } catch (error) {
    console.error(`[email] Failed setup-request admin email to ${to}:`, error.message);
    return { sent: false, error: error.message };
  }
}
