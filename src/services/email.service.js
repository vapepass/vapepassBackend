import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import {
  buildPaymentFailedEmail,
  buildRenewalReminderEmail,
  buildSubscriptionActivatedEmail,
  buildSubscriptionPausedEmail,
} from '../utils/emailTemplates.js';

let transporter = null;

function getTransporter() {
  if (!env.email.host || !env.email.from) return null;

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
  return Boolean(env.email.host && env.email.from);
}

async function sendMail({ to, subject, text, html }) {
  const transport = getTransporter();

  if (!transport) {
    console.warn(`[email] SMTP not configured. Would send to ${to}: ${subject}`);
    console.warn(text);
    return { sent: false, devFallback: true };
  }

  await transport.sendMail({
    from: env.email.from,
    to,
    subject,
    text,
    html,
  });

  return { sent: true };
}

/**
 * Sends password reset email. In development without SMTP, logs the link.
 * Never throws — callers should treat forgot-password as always successful.
 */
export async function sendPasswordResetEmail(to, resetToken) {
  const resetUrl = `${env.clientUrl.replace(/\/+$/, '')}/reset-password?token=${resetToken}`;
  const transport = getTransporter();

  if (!transport) {
    console.warn(`[email] SMTP not configured. Password reset link for ${to}: ${resetUrl}`);
    return { sent: false, devFallback: true };
  }

  await transport.sendMail({
    from: env.email.from,
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

  return { sent: true };
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
