const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Razorpay = require('razorpay');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { blockAdminCommerce } = require('../middleware/commerceAccess');
const { sendOrderNotificationToAdmin } = require('../utils/emailService');

// All order routes require authentication
router.use(authenticateToken);
router.use(blockAdminCommerce);

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) return null;
  return String(value).trim();
}

// Create order
router.post('/', async (req, res) => {
  try {
    const orderData = {
      ...req.body,
      user_id: req.user.id
    };

    const order = await Order.create(orderData);

    // Send notification email to admin (fire and forget — never blocks response)
    setImmediate(async () => {
      try {
        const userResult = await db.query(
          'SELECT full_name, phone FROM users WHERE id = $1',
          [req.user.id]
        );
        const customer = userResult.rows[0] || {};
        await sendOrderNotificationToAdmin(order, customer, orderData.items || []);
      } catch (emailErr) {
        console.error('Order email notification error:', emailErr.message);
      }
    });

    res.status(201).json({ 
      message: 'Order placed successfully.',
      order 
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order.' });
  }
});

// Get user's orders
router.get('/', async (req, res) => {
  try {
    const { status, limit } = req.query;
    const filters = {
      status,
      limit: limit ? parseInt(limit) : null
    };

    const orders = await Order.findByUserId(req.user.id, filters);
    res.json({ orders });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders.' });
  }
});

// Get specific order
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    // Check if order belongs to user (unless admin)
    const isAdminLike = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (order.user_id !== req.user.id && !isAdminLike) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.json({ order });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order.' });
  }
});

// Cancel an order (customer initiated). If order was paid by Razorpay, initiate refund back to original payment method.
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : 'Customer cancelled';

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    if (order.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (order.status === 'cancelled') {
      return res.json({ message: 'Order already cancelled.', order });
    }

    if (order.status === 'shipped' || order.status === 'delivered') {
      return res.status(409).json({ error: 'This order can no longer be cancelled.' });
    }

    // Cancel + restock first (DB authoritative). Refund will be attempted after.
    const cancelled = await Order.cancelById({
      orderId: Number(id),
      userId: req.user.id,
      reason
    });

    const needsRefund =
      String(cancelled.payment_provider || '').toLowerCase() === 'razorpay' &&
      String(cancelled.payment_status || '').toLowerCase() === 'paid' &&
      !!String(cancelled.payment_gateway_payment_id || '').trim();

    if (!needsRefund) {
      return res.json({
        message: 'Order cancelled successfully.',
        order: cancelled
      });
    }

    const keyId = getRequiredEnv('RAZORPAY_KEY_ID');
    const keySecret = getRequiredEnv('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
      const updated = await Order.updateRefundStatus({
        orderId: cancelled.id,
        refund_status: 'refund_failed',
        refund_id: null,
        refund_amount: null,
        refunded_at: new Date(),
        payment_status: cancelled.payment_status
      });

      return res.status(501).json({
        error: 'Refund could not be initiated (Razorpay not configured on server).',
        order: updated
      });
    }

    // Initiate real Razorpay refund (will go back to original UPI/bank based on gateway rules)
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const refundResponse = await razorpay.payments.refund(String(cancelled.payment_gateway_payment_id), {
      notes: {
        order_id: String(cancelled.id),
        order_number: String(cancelled.order_number || ''),
        reason
      }
    });

    const refundAmount = Number(cancelled.payment_amount || cancelled.total_amount || 0) || null;
    const refundStatusRaw = String(refundResponse?.status || '').toLowerCase();
    const normalizedRefundStatus = refundStatusRaw === 'processed' ? 'refunded' : 'refund_pending';
    const normalizedPaymentStatus = refundStatusRaw === 'processed' ? 'refunded' : 'refund_pending';

    const updated = await Order.updateRefundStatus({
      orderId: cancelled.id,
      refund_status: normalizedRefundStatus,
      refund_id: refundResponse?.id ? String(refundResponse.id) : null,
      refund_amount: refundAmount,
      refunded_at: new Date(),
      payment_status: normalizedPaymentStatus
    });

    return res.json({
      message: 'Order cancelled and refund initiated.',
      order: updated,
      refund: {
        id: refundResponse?.id,
        status: refundResponse?.status
      }
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ error: error.message || 'Failed to cancel order.' });
  }
});

// Quick buy - create order from single product
router.post('/quick-buy', async (req, res) => {
  try {
    const { product_id, quantity = 1, shipping_address, payment_method = 'cash_on_delivery', notes } = req.body;
    
    if (!product_id) {
      return res.status(400).json({ error: 'Product ID is required.' });
    }

    // Get product details
    const productQuery = `
      SELECT id, name, price, wholesale_price, discount_price, stock_quantity 
      FROM products 
      WHERE id = $1
    `;
    const productResult = await require('../config/database').query(productQuery, [product_id]);
    
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const product = productResult.rows[0];
    const retailPrice = product.discount_price != null ? product.discount_price : product.price;
    
    // Check stock
    if (product.stock_quantity < quantity) {
      return res.status(400).json({ error: 'Insufficient stock.' });
    }

    // Determine price based on user type
    const isWholesale = req.user.role === 'wholesale' && req.user.is_approved;
    const price = isWholesale && product.wholesale_price ? product.wholesale_price : retailPrice;
    const subtotal = price * quantity;

    const normalizedPaymentMethod = (() => {
      const raw = (payment_method || '').toString().trim();
      const lower = raw.toLowerCase();
      if (lower === 'cod' || lower === 'cash' || lower === 'cashondelivery') return 'cash_on_delivery';
      if (lower === 'cash_on_delivery') return 'cash_on_delivery';
      if (lower === 'gpay') return 'gpay';
      return raw || 'cash_on_delivery';
    })();

    const normalizedNotes = typeof notes === 'string' && notes.trim() ? notes.trim() : 'Quick Buy Order';

    // Create order
    const orderData = {
      user_id: req.user.id,
      total_amount: subtotal,
      shipping_address: shipping_address || {},
      payment_method: normalizedPaymentMethod,
      notes: normalizedNotes,
      items: [{
        product_id: product.id,
        product_name: product.name,
        quantity,
        price,
        subtotal
      }]
    };

    const order = await Order.create(orderData);
    
    res.status(201).json({ 
      message: 'Order placed successfully!',
      order 
    });
  } catch (error) {
    console.error('Quick buy error:', error);
    res.status(500).json({ error: 'Failed to process quick buy.' });
  }
});

module.exports = router;
