const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const https = require('https');

// ── Resend (HTTPS) ── works on Render since it uses port 443, not SMTP ──
function canUseResend() {
  return !!(String(process.env.RESEND_API_KEY || '').trim() && String(process.env.RESEND_FROM_EMAIL || '').trim());
}

async function sendViaResend({ to, subject, html }) {
  const key  = String(process.env.RESEND_API_KEY || '').trim();
  const from = 'Mount Made <hello@mountain-made.com>';
  const payload = JSON.stringify({ from, to, subject, html });
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', hostname: 'api.resend.com', path: '/emails',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Resend ${res.statusCode}: ${data}`)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── SMTP (port 465 SSL — more reliable on Render than 587) ──
function createTransporter() {
  const host = String(process.env.SMTP_HOST || '').trim();
  // Force port 465 (SSL) — Render blocks 587 (STARTTLS). Override with SMTP_PORT=465 if already set.
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').replace(/\s/g, '');

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 465,
    secure: true,           // always SSL — required for port 465
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

// ── Send via SMTP, fall back to Resend if SMTP fails ──
async function sendEmail({ to, subject, html, fromLabel }) {
  const fromEmail = 'hello@mountain-made.com';
  const from      = fromLabel ? `${fromLabel} <${fromEmail}>` : `Mount Made <${fromEmail}>`;
  let lastErr = null;

  // Try SMTP first
  const transporter = createTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({ from, to, subject, html });
      return; // success
    } catch (err) {
      lastErr = err;
      console.error('[EMAIL] SMTP failed, trying Resend fallback:', err.message);
    }
  }

  // Fallback: Resend via HTTPS (never blocked by Render)
  if (canUseResend()) {
    await sendViaResend({ to, subject, html });
    return; // success via Resend
  }

  // Both failed
  throw lastErr || new Error('No email transport configured.');
}

function getBaseUrl() {
  return String(process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function makeActionToken(type, id, action) {
  return jwt.sign(
    { type, id: String(id), action },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function sendOrderNotificationToAdmin(order, customer, items) {
  const adminEmail = String(process.env.ADMIN_NOTIFICATION_EMAIL || 'mountainmade2026@gmail.com').trim();

  const baseUrl = getBaseUrl();
  const confirmToken = makeActionToken('order', order.id, 'confirm');
  const declineToken = makeActionToken('order', order.id, 'decline');
  const confirmUrl = `${baseUrl}/api/email-actions/order/${order.id}/confirm?token=${confirmToken}`;
  const declineUrl = `${baseUrl}/api/email-actions/order/${order.id}/decline?token=${declineToken}`;

  let address = {};
  try {
    address = typeof order.shipping_address === 'string'
      ? JSON.parse(order.shipping_address)
      : (order.shipping_address || {});
  } catch (_) {}

  const addressStr = [
    address.address || address.street || address.line1,
    address.city,
    address.state,
    address.pincode || address.zip || address.postal_code
  ].filter(Boolean).join(', ') || '-';

  const safeItems = Array.isArray(items) ? items : [];

  const itemRows = safeItems.map((item, idx) => `
    <tr style="background:${idx % 2 === 0 ? '#f9f9f9' : '#fff'};">
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${item.product_name || '-'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">&#8377;${parseFloat(item.price || 0).toFixed(2)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">&#8377;${(parseFloat(item.price || 0) * parseInt(item.quantity || 1)).toFixed(2)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#f0f0f0;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
  <div style="background:#2c7a2c;padding:24px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">&#128722; New Order Received</h1>
    <p style="color:#c8e6c9;margin:6px 0 0;font-size:14px;">Mount Made &#8212; Admin Notification</p>
  </div>
  <div style="padding:24px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;width:40%;border-bottom:1px solid #eee;">Order ID</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${order.order_number || order.id}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Customer Name</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${customer.full_name || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Phone</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${customer.phone || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Delivery Address</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${addressStr}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Payment Method</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${order.payment_method || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;">Total Amount</td><td style="padding:8px 12px;font-size:18px;font-weight:bold;color:#2c7a2c;">&#8377;${parseFloat(order.total_amount || 0).toFixed(2)}</td></tr>
    </table>

    <h3 style="color:#333;margin:20px 0 10px;border-bottom:2px solid #eee;padding-bottom:8px;">&#128230; Items Ordered</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="background:#2c7a2c;color:#fff;">
        <th style="padding:8px 12px;text-align:left;">Product</th>
        <th style="padding:8px 12px;text-align:center;">Qty</th>
        <th style="padding:8px 12px;text-align:right;">Unit Price</th>
        <th style="padding:8px 12px;text-align:right;">Subtotal</th>
      </tr>
      ${itemRows}
    </table>

    <div style="text-align:center;padding:20px 0;border-top:2px solid #eee;">
      <p style="margin:0 0 16px;color:#333;font-weight:bold;font-size:16px;">Take Action on This Order:</p>
      <a href="${confirmUrl}" style="display:inline-block;padding:14px 28px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;margin:0 8px;">&#10003; Confirm Order</a>
      <a href="${declineUrl}" style="display:inline-block;padding:14px 28px;background:#dc3545;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;margin:0 8px;">&#10007; Decline Order</a>
    </div>
    <p style="color:#aaa;font-size:11px;text-align:center;margin-top:16px;">These action links expire in 7 days. Clicking them will automatically update the order status in the admin panel.</p>
  </div>
</div>
</body>
</html>`;

  await sendEmail({
    to: adminEmail,
    subject: `New Order: ${order.order_number || order.id} from ${customer.full_name || 'Customer'}`,
    html,
    fromLabel: 'Mount Made'
  });
}

async function sendReturnNotificationToAdmin(returnRow, customer, items, orderNumber) {
  const adminEmail = String(process.env.ADMIN_NOTIFICATION_EMAIL || 'mountainmade2026@gmail.com').trim();

  const baseUrl = getBaseUrl();
  const approveToken = makeActionToken('return', returnRow.id, 'approve');
  const declineToken = makeActionToken('return', returnRow.id, 'decline');
  const approveUrl = `${baseUrl}/api/email-actions/return/${returnRow.id}/approve?token=${approveToken}`;
  const declineUrl = `${baseUrl}/api/email-actions/return/${returnRow.id}/decline?token=${declineToken}`;

  const safeItems = Array.isArray(items) ? items : [];
  const returnId = returnRow.return_number || `RET-${returnRow.id}`;

  const itemRows = safeItems.map((item, idx) => `
    <tr style="background:${idx % 2 === 0 ? '#f9f9f9' : '#fff'};">
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${item.product_name || '-'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">&#8377;${parseFloat(item.price || 0).toFixed(2)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#f0f0f0;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
  <div style="background:#e67e22;padding:24px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">&#8617; Return Request Received</h1>
    <p style="color:#fdebd0;margin:6px 0 0;font-size:14px;">Mount Made &#8212; Admin Notification</p>
  </div>
  <div style="padding:24px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;width:40%;border-bottom:1px solid #eee;">Return ID</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${returnId}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Order Number</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${orderNumber || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Customer Name</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${customer.full_name || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Phone</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${customer.phone || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;border-bottom:1px solid #eee;">Reason</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${returnRow.reason || '-'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9f9f9;font-weight:bold;">Refund Amount</td><td style="padding:8px 12px;font-size:18px;font-weight:bold;color:#e67e22;">&#8377;${parseFloat(returnRow.refund_amount || 0).toFixed(2)}</td></tr>
    </table>

    <h3 style="color:#333;margin:20px 0 10px;border-bottom:2px solid #eee;padding-bottom:8px;">&#128230; Items to Return</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="background:#e67e22;color:#fff;">
        <th style="padding:8px 12px;text-align:left;">Product</th>
        <th style="padding:8px 12px;text-align:center;">Qty</th>
        <th style="padding:8px 12px;text-align:right;">Unit Price</th>
      </tr>
      ${itemRows}
    </table>

    <div style="text-align:center;padding:20px 0;border-top:2px solid #eee;">
      <p style="margin:0 0 16px;color:#333;font-weight:bold;font-size:16px;">Take Action on This Return:</p>
      <a href="${approveUrl}" style="display:inline-block;padding:14px 28px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;margin:0 8px;">&#10003; Approve Return</a>
      <a href="${declineUrl}" style="display:inline-block;padding:14px 28px;background:#dc3545;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;margin:0 8px;">&#10007; Decline Return</a>
    </div>
    <p style="color:#aaa;font-size:11px;text-align:center;margin-top:16px;">These action links expire in 7 days. Clicking them will automatically update the return status in the admin panel.</p>
  </div>
</div>
</body>
</html>`;

  await sendEmail({
    to: adminEmail,
    subject: `Return Request: ${returnId} from ${customer.full_name || 'Customer'}`,
    html,
    fromLabel: 'Mount Made'
  });
}

module.exports = { sendOrderNotificationToAdmin, sendReturnNotificationToAdmin, sendDeliveryNotificationEmail };

async function sendDeliveryNotificationEmail(toEmail, customerName, orderNumber, notReceivedUrl) {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#f0f0f0;font-family:Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#1a4731,#2d6a4f);padding:28px;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:8px;">&#128666;</div>
    <h1 style="color:#fff;margin:0;font-size:22px;">Your Order is Out for Delivery!</h1>
    <p style="color:#a7f3d0;margin:6px 0 0;font-size:14px;">Mount Made &mdash; Order #${orderNumber}</p>
  </div>
  <div style="padding:28px;text-align:center;">
    <p style="color:#374151;font-size:15px;margin:0 0 8px;">Hello <strong>${customerName}</strong>,</p>
    <p style="color:#374151;font-size:16px;margin:0 0 20px;">Your product is <strong>Out for Delivery</strong>. Your products will be received shortly.</p>
    <div style="background:#f0fdf4;border:2px solid #10b981;border-radius:16px;padding:24px;margin:0 auto 24px;max-width:360px;">
      <div style="font-size:3rem;margin-bottom:12px;">&#128230;</div>
      <p style="color:#065f46;font-size:15px;font-weight:600;margin:0 0 8px;">Order #${orderNumber} is on its way!</p>
      <p style="color:#374151;font-size:14px;margin:0;">If the product isn't received, please press the <strong>Not Received</strong> button below.</p>
    </div>
    <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:6px;padding:14px 16px;text-align:left;margin-bottom:24px;">
      <strong style="color:#92400e;font-size:0.9rem;">&#9888; Important Notice</strong>
      <p style="color:#78350f;font-size:0.9rem;margin:8px 0 0;">Dear Customer, if the product is not received and claim is not made within <strong>2 hours</strong> of the delivery attempt, we will not be able to accept your complaints or claims.</p>
    </div>
    <a href="${notReceivedUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(220,38,38,0.3);">&#128680; Not Received</a>
    <p style="color:#9ca3af;font-size:13px;margin-top:24px;">Thank you for shopping with Mount Made! &#127807;</p>
  </div>
</div>
</body></html>`;

  await sendEmail({
    to: toEmail,
    subject: `\u{1F69A} Your Order #${orderNumber} is Out for Delivery \u2014 Mount Made`,
    html,
    fromLabel: 'Mount Made'
  });
}
