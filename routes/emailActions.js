const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const nodemailer = require('nodemailer');
const {
  notifyOrderConfirmed, notifyOrderDeclined, notifyOrderDelivered,
  notifyReturnApproved, notifyReturnRejected
} = require('../utils/whatsappService');

// ── Send a result email back to admin after they take action ─────────────
async function sendActionResultEmail({ subject, icon, color, title, detail, actionButtonHtml }) {
  const host  = String(process.env.SMTP_HOST || '').trim();
  const port  = parseInt(process.env.SMTP_PORT || '465', 10);
  const user  = String(process.env.SMTP_USER || '').trim();
  const pass  = String(process.env.SMTP_PASS || '').replace(/\s/g, '');
  const to    = String(process.env.ADMIN_NOTIFICATION_EMAIL || user).trim();
  const from  = String(process.env.SMTP_FROM_EMAIL || user).trim();

  if (!host || !user || !pass || !to) return;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:30px;background:#f0f0f0;font-family:Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
  <div style="background:${color};padding:28px;text-align:center;">
    <div style="font-size:52px;line-height:1;margin-bottom:10px;">${icon}</div>
    <h2 style="color:#fff;margin:0;font-size:22px;">${title}</h2>
  </div>
  <div style="padding:24px;text-align:center;">
    <p style="color:#555;font-size:15px;margin:0 0 16px;">${detail}</p>
    ${actionButtonHtml || ''}
    <p style="color:#aaa;font-size:12px;margin-top:20px;">Mount Made &mdash; ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
  </div>
</div>
</body></html>`;

  try {
    const t = nodemailer.createTransport({ host, port, secure: true, auth: { user, pass }, connectionTimeout: 15000, socketTimeout: 20000 });
    await t.sendMail({ from: `Mount Made <${from}>`, to, subject, html });
  } catch (err) {
    console.error('[EMAIL] Action result email failed:', err.message);
  }
}

// ── Test endpoint: hit /api/email-actions/test in a browser to verify SMTP ──
router.get('/test', async (req, res) => {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').replace(/\s/g, '');
  const to   = String(process.env.ADMIN_NOTIFICATION_EMAIL || user).trim();
  const base = String(process.env.APP_BASE_URL || '').trim();

  const config = { host, port, userSet: !!user, passLen: pass.length, to, base };

  if (!host || !user || !pass) {
    return res.status(503).json({ ok: false, error: 'SMTP env vars missing', config });
  }

  try {
    const t = nodemailer.createTransport({
      host, port,
      secure: true,   // port 465 SSL — Render blocks 587
      auth: { user, pass }
    });

    await t.verify();

    const info = await t.sendMail({
      from: `Mount Made <${user}>`,
      to,
      subject: 'Mount Made - Live Server Email Test ' + new Date().toISOString(),
      html: `<h2>Email is working ✅</h2><p>Sent from live server at <b>${base}</b></p><p>${new Date().toISOString()}</p>`
    });

    return res.json({ ok: true, messageId: info.messageId, response: info.response, sentTo: to, config });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, config });
  }
});

// ── HTML response helpers ────────────────────────────────────────────────
function page(icon, color, title, detail) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mount Made</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0f0f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 40px 36px; text-align: center; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.12); }
    .icon { font-size: 64px; margin-bottom: 16px; line-height: 1; }
    h2 { color: ${color}; margin-bottom: 10px; font-size: 22px; }
    p { color: #777; font-size: 14px; margin-top: 8px; }
    .brand { margin-top: 24px; font-size: 12px; color: #bbb; letter-spacing: 1px; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h2>${title}</h2>
    <p>${detail}</p>
    <div class="brand">Mount Made</div>
  </div>
</body>
</html>`;
}

function verifyToken(token, expectedType, expectedId, expectedAction) {
  if (!token) return { error: 'Missing action token.' };

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return { error: 'This link has expired or is invalid. Please manage orders from the admin panel.' };
  }

  if (
    payload.type !== expectedType ||
    String(payload.id) !== String(expectedId) ||
    payload.action !== expectedAction
  ) {
    return { error: 'This link is not valid for the requested action.' };
  }

  return { payload };
}

// ── Order: Confirm / Decline ─────────────────────────────────────────────
router.get('/order/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const { token } = req.query;

  if (!['confirm', 'decline', 'deliver'].includes(action)) {
    return res.status(400).send(page('⚠️', '#dc3545', 'Unknown Action', 'The requested action is not recognized.'));
  }

  const { error } = verifyToken(token, 'order', id, action);
  if (error) {
    return res.status(401).send(page('🔒', '#dc3545', 'Link Invalid or Expired', error));
  }

  const newStatus = action === 'confirm' ? 'processing' : action === 'deliver' ? 'delivered' : 'cancelled';

  try {
    const checkResult = await db.query(
      `SELECT o.id, o.status, o.order_number,
              u.full_name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [id]
    );

    if (!checkResult.rows.length) {
      return res.status(404).send(page('🔍', '#dc3545', 'Order Not Found', 'The order could not be found in the system.'));
    }

    const order = checkResult.rows[0];

    // Already handled — but allow deliver when status is processing
    const alreadyHandled = action === 'deliver'
      ? (order.status === 'delivered' || order.status === 'cancelled')
      : order.status !== 'pending';

    if (alreadyHandled) {
      const alreadyLabel = order.status.charAt(0).toUpperCase() + order.status.slice(1);
      return res.send(page('ℹ️', '#17a2b8', 'Already Processed', `Order ${order.order_number} has already been marked as <strong>${alreadyLabel}</strong>. No changes were made.`));
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newStatus, id]
      );

      // Restore stock if declining
      if (newStatus === 'cancelled') {
        const itemsResult = await client.query(
          'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
          [id]
        );
        for (const item of itemsResult.rows) {
          if (!item.product_id || !item.quantity) continue;
          await client.query(
            'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
            [item.quantity, item.product_id]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (action === 'confirm') {
      // Build a "Mark as Delivered" button for the result email
      const deliveredToken = jwt.sign(
        { type: 'order', id: String(order.id), action: 'deliver' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );
      const baseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
      const deliveredUrl = `${baseUrl}/api/email-actions/order/${order.id}/deliver?token=${deliveredToken}`;
      const deliveredBtn = `<a href="${deliveredUrl}" style="display:inline-block;padding:14px 32px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;margin-top:8px;">&#128666; Mark as Delivered</a>`;

      await sendActionResultEmail({
        subject: `✅ Order Confirmed: ${order.order_number}`,
        icon: '✅', color: '#28a745',
        title: 'Order Confirmed',
        detail: `Order <strong>${order.order_number}</strong> has been confirmed and is now being processed. Click below when the order is delivered:`,
        actionButtonHtml: deliveredBtn
      });
      notifyOrderConfirmed(order.customer_phone, order.customer_name || 'Customer', order.order_number);
      return res.send(page('✅', '#28a745', 'Order Confirmed!', `Order <strong>${order.order_number}</strong> has been confirmed and moved to Processing.`));
    } else if (action === 'deliver') {
      await sendActionResultEmail({
        subject: `🚚 Order Delivered: ${order.order_number}`,
        icon: '🚚', color: '#17a2b8',
        title: 'Order Delivered',
        detail: `Order <strong>${order.order_number}</strong> has been marked as delivered successfully.`
      });
      notifyOrderDelivered(order.customer_phone, order.customer_name || 'Customer', order.order_number);
      return res.send(page('🚚', '#28a745', 'Order Delivered!', `Order <strong>${order.order_number}</strong> has been marked as delivered successfully.`));
    } else {
      // Decline — just notify, no further button
      await sendActionResultEmail({
        subject: `❌ Order Declined: ${order.order_number}`,
        icon: '❌', color: '#dc3545',
        title: 'Order Declined',
        detail: `Order <strong>${order.order_number}</strong> has been declined and cancelled. Stock has been restocked.`
      });
      notifyOrderDeclined(order.customer_phone, order.customer_name || 'Customer', order.order_number);
      return res.send(page('❌', '#dc3545', 'Order Declined', `Order <strong>${order.order_number}</strong> has been declined and cancelled.`));
    }
  } catch (err) {
    console.error('Email action order error:', err);
    return res.status(500).send(page('⚠️', '#dc3545', 'Server Error', 'An unexpected error occurred. Please try again or manage the order from the admin panel.'));
  }
});

// ── Delivery: Not Received ───────────────────────────────────────────────
router.get('/delivery/:id/not-received', async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  const { error } = verifyToken(token, 'delivery', id, 'not_received');
  if (error) {
    return res.status(401).send(page('🔒', '#dc3545', 'Link Invalid or Expired', error));
  }

  try {
    const checkResult = await db.query(
      `SELECT o.id, o.status, o.order_number, o.out_for_delivery_at,
              u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [id]
    );

    if (!checkResult.rows.length) {
      return res.status(404).send(page('🔍', '#dc3545', 'Order Not Found', 'The order could not be found in the system.'));
    }

    const order = checkResult.rows[0];

    // Already delivered — no action needed
    if (order.status === 'delivered') {
      return res.send(page('✅', '#28a745', 'Already Delivered', `Order <strong>${order.order_number}</strong> has already been delivered successfully. If you have a concern, please contact us.`));
    }

    // Only allow reporting if order is out_for_delivery
    if (order.status !== 'out_for_delivery') {
      return res.send(page('ℹ️', '#17a2b8', 'Cannot Report', `Order <strong>${order.order_number}</strong> is currently "${order.status}". Not-received reports can only be made for orders that are out for delivery.`));
    }

    // Check if 3 hours have passed since out_for_delivery_at
    const ofdAt = order.out_for_delivery_at ? new Date(order.out_for_delivery_at) : null;
    const threeHoursMs = 3 * 60 * 60 * 1000;
    const now = new Date();

    if (ofdAt && (now - ofdAt) < threeHoursMs) {
      const remainingMs = threeHoursMs - (now - ofdAt);
      const remainingMin = Math.ceil(remainingMs / 60000);
      return res.send(page('⏳', '#f59e0b', 'Please Wait',
        `Your order <strong>${order.order_number}</strong> was dispatched recently. Please allow up to 3 hours for delivery.<br><br>You can report non-delivery in approximately <strong>${remainingMin} minute${remainingMin !== 1 ? 's' : ''}</strong>.<br><br>If urgent, please contact us directly.`
      ));
    }

    // Mark order as not_received and notify admin
    await db.query(
      `UPDATE orders SET status = 'not_received', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );

    // Notify admin via email
    try {
      await sendActionResultEmail({
        subject: `🚨 Delivery Not Received: ${order.order_number}`,
        icon: '🚨', color: '#dc2626',
        title: 'Delivery Not Received',
        detail: `Customer <strong>${order.customer_name || 'N/A'}</strong> has reported that they did not receive their delivery for order <strong>${order.order_number}</strong>.<br><br>
                 <strong>Customer Email:</strong> ${order.customer_email || 'N/A'}<br>
                 <strong>Customer Phone:</strong> ${order.customer_phone || 'N/A'}<br>
                 <strong>Dispatched At:</strong> ${ofdAt ? ofdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}<br>
                 <strong>Reported At:</strong> ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST<br><br>
                 Please investigate and take appropriate action from the admin panel.`
      });
    } catch (emailErr) {
      console.error('[NOT-RECEIVED] Admin notification email failed:', emailErr.message);
    }

    return res.send(page('📋', '#dc2626', 'Report Submitted',
      `Your non-delivery report for order <strong>${order.order_number}</strong> has been submitted successfully.<br><br>Our team has been notified and will investigate this immediately. We will reach out to you shortly.<br><br>Thank you for your patience.`
    ));
  } catch (err) {
    console.error('Email action delivery not-received error:', err);
    return res.status(500).send(page('⚠️', '#dc3545', 'Server Error', 'An unexpected error occurred. Please try again or contact support.'));
  }
});

// ── Return: Approve / Decline ────────────────────────────────────────────
router.get('/return/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const { token } = req.query;

  if (!['approve', 'decline'].includes(action)) {
    return res.status(400).send(page('⚠️', '#dc3545', 'Unknown Action', 'The requested action is not recognized.'));
  }

  const { error } = verifyToken(token, 'return', id, action);
  if (error) {
    return res.status(401).send(page('🔒', '#dc3545', 'Link Invalid or Expired', error));
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  try {
    const checkResult = await db.query(
      `SELECT r.id, r.status, r.return_number,
              u.full_name AS customer_name, u.phone AS customer_phone
       FROM returns r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.id = $1`,
      [id]
    );

    if (!checkResult.rows.length) {
      return res.status(404).send(page('🔍', '#dc3545', 'Return Not Found', 'The return request could not be found in the system.'));
    }

    const ret = checkResult.rows[0];
    const returnId = ret.return_number || `RET-${ret.id}`;

    // Already handled
    if (ret.status !== 'requested') {
      const alreadyLabel = ret.status.charAt(0).toUpperCase() + ret.status.slice(1);
      return res.send(page('ℹ️', '#17a2b8', 'Already Processed', `Return ${returnId} has already been marked as <strong>${alreadyLabel}</strong>. No changes were made.`));
    }

    await db.query(
      'UPDATE returns SET status = $1, updated_at = NOW() WHERE id = $2',
      [newStatus, id]
    );

    if (action === 'approve') {
      Promise.resolve().then(() => sendActionResultEmail({
        subject: `✅ Return Approved: ${returnId}`,
        icon: '✅', color: '#28a745',
        title: 'Return Approved',
        detail: `Return request <strong>${returnId}</strong> has been approved successfully.`
      })).catch(e => console.error('[EMAIL] approve result email error:', e));
      notifyReturnApproved(ret.customer_phone, ret.customer_name || 'Customer', returnId);
      return res.send(page('✅', '#28a745', 'Return Approved!', `Return request <strong>${returnId}</strong> has been approved.`));
    } else {
      Promise.resolve().then(() => sendActionResultEmail({
        subject: `❌ Return Declined: ${returnId}`,
        icon: '❌', color: '#dc3545',
        title: 'Return Declined',
        detail: `Return request <strong>${returnId}</strong> has been declined and rejected.`
      })).catch(e => console.error('[EMAIL] decline result email error:', e));
      notifyReturnRejected(ret.customer_phone, ret.customer_name || 'Customer', returnId);
      return res.send(page('❌', '#dc3545', 'Return Declined', `Return request <strong>${returnId}</strong> has been declined and rejected.`));
    }
  } catch (err) {
    console.error('Email action return error:', err);
    return res.status(500).send(page('⚠️', '#dc3545', 'Server Error', 'An unexpected error occurred. Please try again or manage the return from the admin panel.'));
  }
});

module.exports = router;
