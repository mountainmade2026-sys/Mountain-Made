/**
 * WhatsApp Business Cloud API service
 *
 * HOW TO SET UP (one-time, ~10 minutes):
 * 1. Go to https://developers.facebook.com and create a developer account
 * 2. Create a new App → choose "Business" type
 * 3. Click "Add Product" → choose "WhatsApp" → click Setup
 * 4. Under "Getting Started", copy:
 *      - Phone Number ID   → set as WHATSAPP_PHONE_NUMBER_ID in Render env vars
 *      - Temporary Token   → set as WHATSAPP_ACCESS_TOKEN in Render env vars
 * 5. Add your customer's WhatsApp number as a "Test Recipient" in the dashboard
 * 6. For production: generate a permanent token and register your real business number
 *
 * Required Render env vars:
 *   WHATSAPP_PHONE_NUMBER_ID   (from Meta Developer dashboard)
 *   WHATSAPP_ACCESS_TOKEN      (from Meta Developer dashboard)
 *   WHATSAPP_API_VERSION       (optional, defaults to v20.0)
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

/**
 * Format Indian phone number for WhatsApp API (no +, just digits e.g. 919876543210)
 */
function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '91' + digits.slice(1);
  if (digits.length >= 10) return digits;
  return null;
}

/**
 * Generate a WhatsApp click-to-chat link (works WITHOUT any API credentials).
 * Admin can use this to open WhatsApp on their phone and send a message manually.
 */
function getWhatsAppLink(phone, text) {
  const num = formatPhone(phone);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(text || '')}`;
}

/**
 * Send a text message via WhatsApp Cloud API.
 * - In sandbox/testing: works to numbers registered as test recipients in Meta dashboard.
 * - In production: works within 24 h of customer messaging you; otherwise use templates.
 * Returns { skipped: true } silently when credentials are not configured.
 */
async function sendWhatsAppMessage(phone, message) {
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const accessToken   = (process.env.WHATSAPP_ACCESS_TOKEN   || '').trim();

  if (!phoneNumberId || !accessToken) {
    console.log('[WHATSAPP] Not configured — skipping send');
    return { skipped: true };
  }

  const to = formatPhone(phone);
  if (!to) {
    console.log('[WHATSAPP] Invalid phone number:', phone);
    return { skipped: true };
  }

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message }
  };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`WhatsApp API ${response.status}: ${JSON.stringify(data?.error || data)}`);
  }
  console.log(`[WHATSAPP] Sent to ${to}: ${data.messages?.[0]?.id || 'ok'}`);
  return data;
}

// ── Pre-built notification messages ──────────────────────────────────────

async function notifyOrderPlaced(phone, name, orderNumber, totalAmount) {
  const msg =
    `Hello ${name}! 🎉\n\n` +
    `Your order *${orderNumber}* has been placed successfully!\n\n` +
    `💰 Total: ₹${totalAmount}\n\n` +
    `We will confirm your order shortly.\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyOrderPlaced failed:', err.message)
  );
}

async function notifyOrderConfirmed(phone, name, orderNumber) {
  const msg =
    `Hello ${name}! ✅\n\n` +
    `Great news! Your order *${orderNumber}* has been *confirmed* and is now being processed.\n\n` +
    `We will update you when it is on its way.\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyOrderConfirmed failed:', err.message)
  );
}

async function notifyOrderDeclined(phone, name, orderNumber) {
  const msg =
    `Hello ${name},\n\n` +
    `We are sorry to inform you that your order *${orderNumber}* has been *declined*.\n\n` +
    `If you have any questions, please contact us.\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyOrderDeclined failed:', err.message)
  );
}

async function notifyOrderDelivered(phone, name, orderNumber) {
  const msg =
    `Hello ${name}! 🚚\n\n` +
    `Your order *${orderNumber}* has been *delivered* successfully!\n\n` +
    `Thank you for shopping with Mount Made. We hope you love your products! 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyOrderDelivered failed:', err.message)
  );
}

async function notifyReturnApproved(phone, name, returnNumber) {
  const msg =
    `Hello ${name}! ✅\n\n` +
    `Your return request *${returnNumber}* has been *approved*.\n\n` +
    `Please ship the item(s) back to us. Your refund will be processed once we receive them.\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyReturnApproved failed:', err.message)
  );
}

async function notifyReturnRejected(phone, name, returnNumber) {
  const msg =
    `Hello ${name},\n\n` +
    `We are sorry, your return request *${returnNumber}* has been *declined*.\n\n` +
    `For more information, please contact our support team.\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyReturnRejected failed:', err.message)
  );
}

module.exports = {
  formatPhone,
  getWhatsAppLink,
  sendWhatsAppMessage,
  notifyOrderPlaced,
  notifyOrderConfirmed,
  notifyOrderDeclined,
  notifyOrderDelivered,
  notifyReturnApproved,
  notifyReturnRejected
};
