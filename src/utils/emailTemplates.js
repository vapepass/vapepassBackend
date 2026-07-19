/**
 * Shared HTML email layout for VapePass transactional emails.
 */

import { env } from '../config/env.js';

const BRAND = {
  purple: '#7c3aed',
  ink: '#0c0c12',
  muted: '#5c5c6d',
  light: '#9494a6',
  border: '#e5e7eb',
  bg: '#f8f7fc',
};

/**
 * Only use remote images when they are publicly reachable over HTTPS.
 * localhost / API_PUBLIC_URL / SVG files break in Gmail and most clients.
 */
function getPublicLogoUrl() {
  const configured = String(env.email?.logoUrl || '').trim();
  if (/^https:\/\//i.test(configured)) return configured;
  return null;
}

/** Inline HTML logo — never depends on remote image hosting */
function buildInlineLogoHtml() {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 12px;">
      <tr>
        <td style="width:42px;height:42px;background:#ffffff;border-radius:11px;text-align:center;vertical-align:middle;">
          <span style="display:inline-block;color:${BRAND.purple};font-size:22px;line-height:42px;font-weight:700;">✦</span>
        </td>
        <td style="padding-left:12px;text-align:left;">
          <div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#ffffff;line-height:1.1;">VapePass</div>
        </td>
      </tr>
    </table>
  `;
}

function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(amount, currency = 'USD') {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

/**
 * @param {{ title: string, bodyHtml: string, preheader?: string }} options
 */
export function wrapEmailLayout({ title, bodyHtml, preheader = '' }) {
  const publicLogoUrl = getPublicLogoUrl();
  const logoBlock = publicLogoUrl
    ? `<img src="${publicLogoUrl}" width="160" alt="VapePass" style="display:block;margin:0 auto 12px;border:0;outline:none;text-decoration:none;max-width:160px;height:auto;" />`
    : buildInlineLogoHtml();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:Inter,Segoe UI,system-ui,sans-serif;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid ${BRAND.border};overflow:hidden;">
          <tr>
            <td style="background:${BRAND.purple};padding:28px 32px;text-align:center;">
              ${logoBlock}
              <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.85);">${title}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
              <p style="margin:32px 0 0;color:${BRAND.muted};font-size:14px;line-height:1.6;">
                Regards,<br />
                <strong style="color:${BRAND.ink};">Team VapePass</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid ${BRAND.border};text-align:center;">
              <p style="margin:0;font-size:12px;color:${BRAND.light};line-height:1.5;">
                © ${new Date().getFullYear()} VapePass. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildSubscriptionActivatedEmail({
  storeName,
  startDate,
  endDate,
}) {
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  const subject = 'Your VapePass Subscription Is Activated';
  const text = [
    'Subscription Activated',
    '',
    `Store Name: ${storeName || 'Your store'}`,
    `Subscription Start Date: ${start}`,
    `Subscription End Date: ${end}`,
    '',
    'Thank you for subscribing to VapePass. Your dashboard and embedding script are now unlocked.',
    '',
    'Regards,',
    'Team VapePass',
  ].join('\n');

  const html = wrapEmailLayout({
    title: 'Subscription Activated',
    preheader: 'Your VapePass subscription is now active.',
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.ink};">Subscription Activated</h1>
      <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Thank you for subscribing to VapePass. Your store dashboard is unlocked and your secure embedding script is ready.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};border-radius:12px;padding:4px;">
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};">Store Name<br/><strong style="color:${BRAND.ink};">${storeName || 'Your store'}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Subscription Start Date<br/><strong style="color:${BRAND.ink};">${start}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Subscription End Date<br/><strong style="color:${BRAND.ink};">${end}</strong></td></tr>
      </table>
      <p style="margin:20px 0 0;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Thank you for choosing VapePass.
      </p>
    `,
  });

  return { subject, text, html };
}

export function buildRenewalReminderEmail({
  storeName,
  renewalDate,
  amount,
  currency = 'USD',
}) {
  const renewal = formatDate(renewalDate);
  const price = formatMoney(amount, currency);
  const subject = 'Your VapePass Subscription Will Renew Soon';
  const text = [
    `Hi${storeName ? ` ${storeName}` : ''},`,
    '',
    'This is a friendly reminder that your VapePass subscription will renew soon.',
    '',
    `Renewal date: ${renewal}`,
    `Amount: ${price}`,
    '',
    'Please ensure your payment method is up to date to avoid any interruption to your chatbot service.',
    '',
    'Regards,',
    'Team VapePass',
  ].join('\n');

  const html = wrapEmailLayout({
    title: 'Renewal Reminder',
    preheader: `Your subscription renews on ${renewal}.`,
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.ink};">Your subscription will renew soon</h1>
      <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        This is a billing reminder for <strong style="color:${BRAND.ink};">${storeName || 'your store'}</strong>.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};border-radius:12px;">
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};">Renewal date<br/><strong style="color:${BRAND.ink};">${renewal}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Amount<br/><strong style="color:${BRAND.ink};">${price}</strong></td></tr>
      </table>
      <p style="margin:20px 0 0;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        No action is required if your payment method is current. We will charge your card automatically on the renewal date.
      </p>
    `,
  });

  return { subject, text, html };
}

export function buildPaymentFailedEmail({ storeName, retryAttempted = true }) {
  const subject = "We couldn't process your payment";
  const text = [
    `Hi${storeName ? ` ${storeName}` : ''},`,
    '',
    "We couldn't process your payment for your VapePass subscription.",
    retryAttempted
      ? "We'll automatically retry shortly."
      : 'Please update your payment method to restore service.',
    '',
    'Please update your payment method if required.',
    '',
    'Regards,',
    'Team VapePass',
  ].join('\n');

  const html = wrapEmailLayout({
    title: 'Payment Failed',
    preheader: "We couldn't process your VapePass payment.",
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.ink};">We couldn't process your payment</h1>
      <p style="margin:0 0 16px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        We were unable to process the latest payment for <strong style="color:${BRAND.ink};">${storeName || 'your store'}</strong>.
      </p>
      <p style="margin:0 0 16px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        ${retryAttempted ? "We'll automatically retry shortly." : 'Automatic retries have been exhausted.'}
      </p>
      <p style="margin:0;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Please update your payment method if required to keep your dashboard and chatbot active.
      </p>
    `,
  });

  return { subject, text, html };
}

export function buildSubscriptionPausedEmail({ storeName }) {
  const subject = 'Your VapePass subscription is paused';
  const text = [
    `Hi${storeName ? ` ${storeName}` : ''},`,
    '',
    'Your VapePass subscription has been paused after repeated payment failures.',
    'Your dashboard is locked and the chatbot has been disabled until billing is updated.',
    '',
    'Regards,',
    'Team VapePass',
  ].join('\n');

  const html = wrapEmailLayout({
    title: 'Subscription Paused',
    preheader: 'Your VapePass subscription is paused.',
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.ink};">Subscription Paused</h1>
      <p style="margin:0;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Your subscription for <strong style="color:${BRAND.ink};">${storeName || 'your store'}</strong> is paused after repeated payment failures.
        The dashboard is locked and the chatbot embedding script will not load until you update billing.
      </p>
    `,
  });

  return { subject, text, html };
}

/**
 * Customer confirmation after Free Setup Assistance request.
 */
export function buildSetupRequestCustomerEmail({
  customerName,
  storeName,
  websiteUrl,
}) {
  const safeName = escapeHtml(customerName || 'there');
  const safeStore = escapeHtml(storeName || 'Your store');
  const safeWebsite = escapeHtml(websiteUrl || '—');
  const subject = 'Request Received – VapePass Free Setup Assistance';

  const text = [
    `Hello ${customerName || 'there'},`,
    '',
    'Thank you for requesting our Free Setup Assistance.',
    '',
    'We have successfully received your request.',
    '',
    'Our support team will contact you during business hours to help install the VapePass AI Assistant on your website.',
    '',
    'If required, we can schedule a live support session to complete the installation together.',
    '',
    `Store: ${storeName || 'Your store'}`,
    `Website: ${websiteUrl || '—'}`,
    '',
    'Thank you for choosing VapePass.',
    '',
    'Best Regards,',
    'The VapePass Team',
  ].join('\n');

  const html = wrapEmailLayout({
    title: 'Free Setup Assistance',
    preheader: 'We received your VapePass free setup request.',
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.ink};">Request received</h1>
      <p style="margin:0 0 16px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Hello ${safeName},
      </p>
      <p style="margin:0 0 16px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Thank you for requesting our Free Setup Assistance. We have successfully received your request.
      </p>
      <p style="margin:0 0 16px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Our support team will contact you during business hours to help install the VapePass AI Assistant on your website.
      </p>
      <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        If required, we can schedule a live support session to complete the installation together.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};border-radius:12px;">
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};">Store<br/><strong style="color:${BRAND.ink};">${safeStore}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Website<br/><strong style="color:${BRAND.ink};word-break:break-all;">${safeWebsite}</strong></td></tr>
      </table>
      <p style="margin:20px 0 0;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        Thank you for choosing VapePass.
      </p>
    `,
  });

  return { subject, text, html };
}

/**
 * Admin notification for a new Free Setup Assistance request.
 */
export function buildSetupRequestAdminEmail({
  customerName,
  storeName,
  email,
  phone,
  websiteUrl,
  message,
  submittedAt,
}) {
  const submitted = formatDateTime(submittedAt || new Date());
  const safe = {
    customerName: escapeHtml(customerName || '—'),
    storeName: escapeHtml(storeName || '—'),
    email: escapeHtml(email || '—'),
    phone: escapeHtml(phone || '—'),
    websiteUrl: escapeHtml(websiteUrl || '—'),
    message: escapeHtml(message || '—'),
    submitted: escapeHtml(submitted),
  };

  const subject = 'New Free Setup Request';
  const text = [
    'New Free Setup Request',
    '',
    `Customer Name: ${customerName || '—'}`,
    `Store Name: ${storeName || '—'}`,
    `Email: ${email || '—'}`,
    `Phone Number: ${phone || '—'}`,
    `Website URL: ${websiteUrl || '—'}`,
    `Message: ${message || '—'}`,
    `Submission Date & Time: ${submitted}`,
    '',
    'Please follow up during business hours.',
  ].join('\n');

  const html = wrapEmailLayout({
    title: 'New Setup Request',
    preheader: `${customerName || 'A customer'} requested free setup assistance.`,
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.ink};">New Free Setup Request</h1>
      <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">
        A customer submitted a Free Setup Assistance request. Details below:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};border-radius:12px;">
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};">Customer Name<br/><strong style="color:${BRAND.ink};">${safe.customerName}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Store Name<br/><strong style="color:${BRAND.ink};">${safe.storeName}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Email<br/><strong style="color:${BRAND.ink};">${safe.email}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Phone Number<br/><strong style="color:${BRAND.ink};">${safe.phone}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Website URL<br/><strong style="color:${BRAND.ink};word-break:break-all;">${safe.websiteUrl}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Optional Message<br/><strong style="color:${BRAND.ink};white-space:pre-wrap;">${safe.message}</strong></td></tr>
        <tr><td style="padding:14px 18px;font-size:14px;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">Submission Date &amp; Time<br/><strong style="color:${BRAND.ink};">${safe.submitted}</strong></td></tr>
      </table>
    `,
  });

  return { subject, text, html };
}
