const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// ── Customer: Request a return ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const userId = req.user.id;
    const { order_id, reason, items } = req.body;

    if (!order_id || !reason || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'order_id, reason, and items[] are required.' });
    }

    // Verify order belongs to user and is delivered
    const orderCheck = await client.query(
      'SELECT id, status, user_id FROM orders WHERE id = $1',
      [order_id]
    );
    if (!orderCheck.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = orderCheck.rows[0];
    if (order.user_id !== userId) return res.status(403).json({ error: 'Access denied.' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Only delivered orders can be returned.' });
    }

    // Check no existing open return for this order
    const existingReturn = await client.query(
      "SELECT id FROM returns WHERE order_id = $1 AND user_id = $2 AND status NOT IN ('rejected', 'refunded')",
      [order_id, userId]
    );
    if (existingReturn.rows.length > 0) {
      return res.status(409).json({ error: 'A return request already exists for this order.' });
    }

    // Validate items belong to the order
    const orderItemIds = items.map(i => i.order_item_id);
    const validItems = await client.query(
      'SELECT id, product_id, quantity, price FROM order_items WHERE order_id = $1 AND id = ANY($2)',
      [order_id, orderItemIds]
    );
    if (validItems.rows.length !== orderItemIds.length) {
      return res.status(400).json({ error: 'Some items do not belong to this order.' });
    }

    const validMap = {};
    validItems.rows.forEach(r => { validMap[r.id] = r; });

    // Calculate refund and build return items
    let refundAmount = 0;
    const returnItems = items.map(i => {
      const orig = validMap[i.order_item_id];
      const qty = Math.min(parseInt(i.quantity) || orig.quantity, orig.quantity);
      const price = parseFloat(orig.price);
      refundAmount += qty * price;
      return { order_item_id: orig.id, product_id: orig.product_id, quantity: qty, price };
    });

    await client.query('BEGIN');

    const returnResult = await client.query(
      `INSERT INTO returns (order_id, user_id, reason, status, refund_amount, created_at, updated_at)
       VALUES ($1, $2, $3, 'requested', $4, NOW(), NOW()) RETURNING *`,
      [order_id, userId, reason.substring(0, 1000), refundAmount]
    );
    const returnRow = returnResult.rows[0];

    for (const ri of returnItems) {
      await client.query(
        `INSERT INTO return_items (return_id, order_item_id, product_id, quantity, price)
         VALUES ($1, $2, $3, $4, $5)`,
        [returnRow.id, ri.order_item_id, ri.product_id, ri.quantity, ri.price]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ message: 'Return request submitted successfully.', return: returnRow });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create return error:', error);
    res.status(500).json({ error: 'Failed to create return request.' });
  } finally {
    client.release();
  }
});

// ── Customer: Get my returns ────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.query(
      `SELECT r.*,
              o.order_number, o.total_amount as order_total,
              json_agg(json_build_object(
                'id', ri.id,
                'order_item_id', ri.order_item_id,
                'product_id', ri.product_id,
                'quantity', ri.quantity,
                'price', ri.price,
                'product_name', p.name,
                'product_image', COALESCE(p.image_url, '')
              )) as items
       FROM returns r
       JOIN orders o ON o.id = r.order_id
       LEFT JOIN return_items ri ON ri.return_id = r.id
       LEFT JOIN products p ON p.id = ri.product_id
       WHERE r.user_id = $1
       GROUP BY r.id, o.order_number, o.total_amount
       ORDER BY r.created_at DESC`,
      [userId]
    );
    res.json({ returns: result.rows });
  } catch (error) {
    console.error('Get returns error:', error);
    res.status(500).json({ error: 'Failed to fetch returns.' });
  }
});

module.exports = router;
