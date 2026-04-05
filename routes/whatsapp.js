const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { adminCheck } = require('../middleware/adminCheck');
const { sendWhatsAppMessage, getWhatsAppLink, formatPhone } = require('../utils/whatsappService');

// All routes require admin auth
router.use(authenticateToken);
router.use(adminCheck);

/**
 * POST /api/whatsapp/send
 * Admin sends a custom WhatsApp message to a customer.
 * Body: { phone, message }
 * Returns: { sent: true } or { sent: false, waLink } if API not configured
 */
router.post('/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message || !String(message).trim()) {
    return res.status(400).json({ error: 'phone and message are required.' });
  }

  const to = formatPhone(phone);
  if (!to) {
    return res.status(400).json({ error: 'Invalid phone number format.' });
  }

  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const accessToken   = (process.env.WHATSAPP_ACCESS_TOKEN   || '').trim();

  if (!phoneNumberId || !accessToken) {
    // API not set up — return a wa.me click-to-chat link as fallback
    const waLink = getWhatsAppLink(phone, message);
    return res.json({ sent: false, waLink, reason: 'WhatsApp API not configured. Use the link to send manually.' });
  }

  try {
    await sendWhatsAppMessage(phone, String(message).trim());
    return res.json({ sent: true });
  } catch (err) {
    console.error('[WHATSAPP] Manual send error:', err.message);
    // Still provide the wa.me fallback on error
    const waLink = getWhatsAppLink(phone, message);
    return res.status(500).json({ sent: false, waLink, error: err.message });
  }
});

/**
 * GET /api/whatsapp/status
 * Returns whether WhatsApp API credentials are configured.
 */
router.get('/status', (req, res) => {
  const configured = !!(
    (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim() &&
    (process.env.WHATSAPP_ACCESS_TOKEN   || '').trim()
  );
  res.json({ configured });
});

module.exports = router;
