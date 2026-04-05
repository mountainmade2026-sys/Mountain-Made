const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

function createTransporter() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: Number(port) === 465,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
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
  const transporter = createTransporter();
  const adminEmail = String(process.env.ADMIN_NOTIFICATION_EMAIL || 'mountainmade2026@gmail.com').trim();
  const fromEmail = String(process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '').trim();

  if (!transporter || !fromEmail) return; // Email not configured yet

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

  try {
    await transporter.sendMail({
      from: `Mount Made <${fromEmail}>`,
      to: adminEmail,
      subject: `New Order: ${order.order_number || order.id} from ${customer.full_name || 'Customer'}`,
      html
    });
  } catch (err) {
    console.error('Order notification email error:', err.message);
  }
}

async function sendReturnNotificationToAdmin(returnRow, customer, items, orderNumber) {
  const transporter = createTransporter();
  const adminEmail = String(process.env.ADMIN_NOTIFICATION_EMAIL || 'mountainmade2026@gmail.com').trim();
  const fromEmail = String(process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '').trim();

  if (!transporter || !fromEmail) return;

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

  try {
    await transporter.sendMail({
      from: `Mount Made <${fromEmail}>`,
      to: adminEmail,
      subject: `Return Request: ${returnId} from ${customer.full_name || 'Customer'}`,
      html
    });
  } catch (err) {
    console.error('Return notification email error:', err.message);
  }
}

module.exports = { sendOrderNotificationToAdmin, sendReturnNotificationToAdmin };
