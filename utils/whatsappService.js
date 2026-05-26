/**
 * WhatsApp via Twilio
 *
 * HOW TO SET UP (free sandbox, ~5 minutes):
 * 1. Sign up at https://twilio.com (free trial — no credit card needed to start)
 * 2. From dashboard copy:
 *      Account SID  → TWILIO_ACCOUNT_SID
 *      Auth Token   → TWILIO_AUTH_TOKEN
 * 3. Go to Messaging → Try it out → Send a WhatsApp message
 * 4. The sandbox FROM number is shown there (e.g. +14155238886)
 *      → set TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
 * 5. Each customer must first send "join <word>" to that number once to opt in
 *    (sandbox only — production doesn't need this)
 * 6. For production: register your own WhatsApp business number in Twilio console
 *
 * Required Render env vars:
 *   TWILIO_ACCOUNT_SID        (from Twilio dashboard)
 *   TWILIO_AUTH_TOKEN         (from Twilio dashboard)
 *   TWILIO_WHATSAPP_FROM      (e.g. whatsapp:+14155238886)
 */

const twilio = require('twilio');

/**
 * Format Indian phone number for Twilio WhatsApp (e.g. whatsapp:+919876543210)
 */
function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  let e164;
  if (digits.length === 10) e164 = '+91' + digits;
  else if (digits.startsWith('91') && digits.length === 12) e164 = '+' + digits;
  else if (digits.startsWith('0') && digits.length === 11) e164 = '+91' + digits.slice(1);
  else if (digits.length >= 10) e164 = '+' + digits;
  else return null;
  return e164;
}

/**
 * Generate a wa.me click-to-chat link — works without any API credentials.
 */
function getWhatsAppLink(phone, text) {
  const e164 = formatPhone(phone);
  if (!e164) return null;
  const num = e164.replace('+', '');
  return `https://wa.me/${num}?text=${encodeURIComponent(text || '')}`;
}

/**
 * Send a WhatsApp message via Twilio.
 * In sandbox mode customers must first send "join <word>" to the from-number.
 * Returns { skipped: true } silently when credentials are not configured.
 */
async function sendWhatsAppMessage(phone, message) {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID    || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN     || '').trim();
  const from       = (process.env.TWILIO_WHATSAPP_FROM  || '').trim();

  if (!accountSid || !authToken || !from) {
    console.log('[WHATSAPP] Twilio not configured — skipping send');
    return { skipped: true };
  }

  const e164 = formatPhone(phone);
  if (!e164) {
    console.log('[WHATSAPP] Invalid phone number:', phone);
    return { skipped: true };
  }

  const client = twilio(accountSid, authToken);
  const msg = await client.messages.create({
    from,
    to: 'whatsapp:' + e164,
    body: message
  });

  console.log(`[WHATSAPP] Sent to ${e164}: ${msg.sid}`);
  return msg;
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
  notifyOrderShipped,
  notifyOrderDeclined,
  notifyOrderDelivered,
  notifyReturnApproved,
  notifyReturnRejected,
  notifyOutForDelivery,
  notifyCourierDispatch
};

async function notifyOrderShipped(phone, name, orderNumber) {
  const msg =
    `Hello ${name}! 🚚\n\n` +
    `Your order *${orderNumber}* has been *shipped* and is on its way to you.\n\n` +
    `You will receive another update once it is out for delivery.\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyOrderShipped failed:', err.message)
  );
}

async function notifyOutForDelivery(phone, name, orderNumber, otp) {
  const otpLine = otp
    ? `🔐 *Your Delivery OTP: ${otp}*\n\nPlease share this OTP with the delivery person when they arrive to confirm receipt.\n\n⚠️ Do NOT share this OTP with anyone else.`
    : `🔐 Your delivery OTP will be shared by the delivery executive when they arrive.\n\nPlease keep your phone nearby and confirm the delivery once it reaches you.`;

  const msg =
    `Hello ${name}! 🚚\n\n` +
    `Great news! Your order *${orderNumber}* is *Out for Delivery* and will reach you shortly.\n\n` +
    `${otpLine}\n\n` +
    `— Mount Made 🌿`;
  return sendWhatsAppMessage(phone, msg).catch(err =>
    console.error('[WHATSAPP] notifyOutForDelivery failed:', err.message)
  );
}

async function notifyCourierDispatch(courierPhone, orderNumber, confirmUrl) {
  const msg =
    `*Mount Made \u2014 Delivery Assignment* \uD83D\uDCE6\n\n` +
    `You have been assigned delivery for order *${orderNumber}*.\n\n` +
    `*Instructions:*\n` +
    `1. Deliver the package to the customer.\n` +
    `2. Ask the customer for their *6-digit OTP*.\n` +
    `3. Open the link below, enter the OTP and press Confirm Delivery.\n\n` +
    `\uD83D\uDD17 Confirm Delivery Link:\n${confirmUrl}\n\n` +
    `\u2014 Mount Made Team`;
  return sendWhatsAppMessage(courierPhone, msg).catch(err =>
    console.error('[WHATSAPP] notifyCourierDispatch failed:', err.message)
  );
}