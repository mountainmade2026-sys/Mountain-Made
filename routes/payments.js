const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const db = require('../config/database');
const Order = require('../models/Order');
const { authenticateToken } = require('../middleware/auth');
const { blockAdminCommerce } = require('../middleware/commerceAccess');

const router = express.Router();

router.use(authenticateToken);
router.use(blockAdminCommerce);

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    return null;
  }
  return String(value).trim();
}

async function getSiteSettings() {
  try {
    const result = await db.query('SELECT setting_key, setting_value FROM site_settings');
    const settings = {};
    for (const row of result.rows || []) {
      settings[row.setting_key] = row.setting_value;
    }
    return settings;
  } catch (_) {
    return {};
  }
}

function parseBool(value) {
  const raw = (value ?? '').toString().trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function parseNonNegativeNumber(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

async function fetchServerCart(userId, role) {
  const query = `
    SELECT c.id, c.quantity, c.product_id,
           p.name,
           p.price as original_price,
           COALESCE(p.discount_price, p.price) as retail_price,
           p.wholesale_price, p.image_url, p.stock_quantity,
           p.min_wholesale_qty,
           (CASE
             WHEN $2 = 'wholesale' AND c.quantity >= p.min_wholesale_qty
             THEN p.wholesale_price * c.quantity
             ELSE COALESCE(p.discount_price, p.price) * c.quantity
           END) as subtotal,
           (CASE
             WHEN $2 = 'wholesale' AND c.quantity >= p.min_wholesale_qty
             THEN p.wholesale_price
             ELSE COALESCE(p.discount_price, p.price)
           END) as price
    FROM cart c
    JOIN products p ON c.product_id = p.id
    WHERE c.user_id = $1 AND p.is_active = true
    ORDER BY c.created_at DESC
  `;

  const result = await db.query(query, [userId, role]);
  const cartItems = result.rows || [];

  const total = cartItems.reduce((sum, item) => sum + Number.parseFloat(item.subtotal), 0);

  return {
    cartItems,
    total: Number.isFinite(total) ? total : 0
  };
}

function verifyRazorpaySignature({ orderId, paymentId, signature, keySecret }) {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
  return expected === signature;
}

// Create a Razorpay order based on SERVER cart total.
router.post('/razorpay/create', async (req, res) => {
  try {
    const keyId = getRequiredEnv('RAZORPAY_KEY_ID');
    const keySecret = getRequiredEnv('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
      return res.status(501).json({ error: 'Razorpay is not configured on server.' });
    }

    const { delivery_speed = 'standard' } = req.body || {};

    const settings = await getSiteSettings();
    const stdEnabled = parseBool(settings.standard_delivery_enabled || settings.fast_delivery_enabled);
    const stdCharge = parseNonNegativeNumber(settings.standard_delivery_charge || settings.fast_delivery_charge);

    const deliverySpeed = 'standard';
    const deliveryCharge = stdEnabled ? stdCharge : 0;

    const { cartItems, total } = await fetchServerCart(req.user.id, req.user.role);
    if (!cartItems.length) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const totalAmount = (Number(total) || 0) + (Number(deliveryCharge) || 0);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ error: 'Invalid cart total.' });
    }

    const amountPaise = Math.round(totalAmount * 100);

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const receipt = `MM_${req.user.id}_${Date.now()}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      payment_capture: 1,
      notes: {
        user_id: String(req.user.id),
        delivery_speed: deliverySpeed
      }
    });

    return res.json({
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      delivery_charge: deliveryCharge,
      delivery_speed: deliverySpeed
    });
  } catch (error) {
    console.error('Razorpay create error:', error);
    return res.status(500).json({ error: 'Failed to start payment.' });
  }
});

// Verify payment signature, fetch Razorpay order, re-check SERVER cart total matches paid amount, then create internal order.
router.post('/razorpay/verify', async (req, res) => {
  try {
    const keyId = getRequiredEnv('RAZORPAY_KEY_ID');
    const keySecret = getRequiredEnv('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
      return res.status(501).json({ error: 'Razorpay is not configured on server.' });
    }

    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      shipping_address,
      notes = '',
      delivery_speed = 'standard',
      delivery_charge = 0
    } = req.body || {};

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification fields.' });
    }

    const signatureOk = verifyRazorpaySignature({
      orderId: String(razorpay_order_id),
      paymentId: String(razorpay_payment_id),
      signature: String(razorpay_signature),
      keySecret
    });

    if (!signatureOk) {
      return res.status(400).json({ error: 'Payment verification failed.' });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const rpOrder = await razorpay.orders.fetch(String(razorpay_order_id));

    const { cartItems, total } = await fetchServerCart(req.user.id, req.user.role);
    if (!cartItems.length) {
      return res.status(400).json({ error: 'Your cart is empty. Please contact support with your payment ID.' });
    }

    const serverTotalAmount = (Number(total) || 0) + (Number(delivery_charge) || 0);
    const serverAmountPaise = Math.round(serverTotalAmount * 100);

    if (Number(rpOrder.amount) !== serverAmountPaise) {
      return res.status(409).json({
        error: 'Cart total changed during payment. Please try again.',
        server_amount: serverAmountPaise,
        paid_amount: rpOrder.amount
      });
    }

    const items = cartItems.map(item => ({
      product_id: item.product_id,
      product_name: item.name,
      quantity: Math.max(1, Number(item.quantity) || 1),
      price: Number(item.price) || 0,
      subtotal: Number(item.subtotal) || 0
    }));

    const orderData = {
      user_id: req.user.id,
      total_amount: serverTotalAmount,
      shipping_address: shipping_address || {},
      payment_method: 'gpay',
      payment_provider: 'razorpay',
      payment_status: 'paid',
      payment_currency: String(rpOrder.currency || 'INR'),
      payment_amount: serverTotalAmount,
      payment_gateway_order_id: String(razorpay_order_id),
      payment_gateway_payment_id: String(razorpay_payment_id),
      payment_gateway_signature: String(razorpay_signature),
      paid_at: new Date(),
      notes: String(notes || '').trim(),
      delivery_speed: String(delivery_speed || 'standard'),
      delivery_charge: Number(delivery_charge) || 0,
      items
    };

    const order = await Order.create(orderData);

    return res.status(201).json({
      message: 'Payment verified and order placed successfully.',
      order
    });
  } catch (error) {
    console.error('Razorpay verify error:', error);
    return res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

module.exports = router;
