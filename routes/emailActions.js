const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const nodemailer = require('nodemailer');

// ── Send a result email back to admin after they take action ─────────────
async function sendActionResultEmail({ subject, icon, color, title, detail }) {
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
    <p style="color:#555;font-size:15px;margin:0 0 8px;">${detail}</p>
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

  if (!['confirm', 'decline'].includes(action)) {
    return res.status(400).send(page('⚠️', '#dc3545', 'Unknown Action', 'The requested action is not recognized.'));
  }

  const { error } = verifyToken(token, 'order', id, action);
  if (error) {
    return res.status(401).send(page('🔒', '#dc3545', 'Link Invalid or Expired', error));
  }

  const newStatus = action === 'confirm' ? 'processing' : 'cancelled';

  try {
    const checkResult = await db.query(
      'SELECT id, status, order_number FROM orders WHERE id = $1',
      [id]
    );

    if (!checkResult.rows.length) {
      return res.status(404).send(page('🔍', '#dc3545', 'Order Not Found', 'The order could not be found in the system.'));
    }

    const order = checkResult.rows[0];

    // Already handled
    if (order.status !== 'pending') {
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
      // Send result email back to admin inbox
      setImmediate(() => sendActionResultEmail({
        subject: `✅ Order Confirmed: ${order.order_number}`,
        icon: '✅', color: '#28a745',
        title: 'Order Confirmed',
        detail: `Order <strong>${order.order_number}</strong> has been confirmed and is now being processed.`
      }));
      return res.send(page('✅', '#28a745', 'Order Confirmed!', `Order <strong>${order.order_number}</strong> has been confirmed and moved to Processing.`));
    } else {
      // Send result email back to admin inbox
      setImmediate(() => sendActionResultEmail({
        subject: `❌ Order Declined: ${order.order_number}`,
        icon: '❌', color: '#dc3545',
        title: 'Order Declined',
        detail: `Order <strong>${order.order_number}</strong> has been declined and cancelled. Stock has been restocked.`
      }));
      return res.send(page('❌', '#dc3545', 'Order Declined', `Order <strong>${order.order_number}</strong> has been declined and cancelled.`));
    }
  } catch (err) {
    console.error('Email action order error:', err);
    return res.status(500).send(page('⚠️', '#dc3545', 'Server Error', 'An unexpected error occurred. Please try again or manage the order from the admin panel.'));
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
      'SELECT id, status, return_number FROM returns WHERE id = $1',
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
      setImmediate(() => sendActionResultEmail({
        subject: `✅ Return Approved: ${returnId}`,
        icon: '✅', color: '#28a745',
        title: 'Return Approved',
        detail: `Return request <strong>${returnId}</strong> has been approved successfully.`
      }));
      return res.send(page('✅', '#28a745', 'Return Approved!', `Return request <strong>${returnId}</strong> has been approved.`));
    } else {
      setImmediate(() => sendActionResultEmail({
        subject: `❌ Return Declined: ${returnId}`,
        icon: '❌', color: '#dc3545',
        title: 'Return Declined',
        detail: `Return request <strong>${returnId}</strong> has been declined and rejected.`
      }));
      return res.send(page('❌', '#dc3545', 'Return Declined', `Return request <strong>${returnId}</strong> has been declined and rejected.`));
    }
  } catch (err) {
    console.error('Email action return error:', err);
    return res.status(500).send(page('⚠️', '#dc3545', 'Server Error', 'An unexpected error occurred. Please try again or manage the return from the admin panel.'));
  }
});

module.exports = router;
