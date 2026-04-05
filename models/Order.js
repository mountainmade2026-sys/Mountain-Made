const db = require('../config/database');

class Order {
  static buildOrderNumberBase(date = new Date()) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `MMDL${day}${month}${year}`;
  }

  static async generateOrderNumber(client, base) {
    const query = `
      SELECT order_number
      FROM orders
      WHERE order_number LIKE $1
    `;

    const result = await client.query(query, [`${base}%`]);
    const existing = result.rows.map(r => String(r.order_number || '').trim()).filter(Boolean);

    if (!existing.includes(base)) {
      return base;
    }

    let maxSuffix = 0;
    for (const orderNumber of existing) {
      if (orderNumber === base) {
        if (maxSuffix < 1) maxSuffix = 1;
        continue;
      }

      let suffixValue = null;

      const plainSuffixMatch = orderNumber.match(new RegExp(`^${base}(\\d+)$`));
      if (plainSuffixMatch) {
        suffixValue = parseInt(plainSuffixMatch[1], 10);
      }

      // Backward compatibility with previously generated dashed IDs.
      if (!Number.isFinite(suffixValue)) {
        const dashedSuffixMatch = orderNumber.match(new RegExp(`^${base}-(\\d+)$`));
        if (dashedSuffixMatch) {
          suffixValue = parseInt(dashedSuffixMatch[1], 10);
        }
      }

      if (Number.isFinite(suffixValue) && suffixValue > maxSuffix) {
        maxSuffix = suffixValue;
      }
    }

    return `${base}${maxSuffix + 1}`;
  }

  static async create(orderData) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      const {
        user_id,
        total_amount,
        shipping_address,
        payment_method,
        payment_provider = null,
        payment_status = null,
        payment_currency = 'INR',
        payment_amount = null,
        payment_gateway_order_id = null,
        payment_gateway_payment_id = null,
        payment_gateway_signature = null,
        paid_at = null,
        notes,
        items,
        delivery_speed = null,
        delivery_charge = 0
      } = orderData;
      
      // Generate unique business order number (MMDLDDMMYYYY, then MMDLDDMMYYYY2, MMDLDDMMYYYY3...)
      const orderBase = this.buildOrderNumberBase(new Date());
      const orderQuery = `
        INSERT INTO orders (
          user_id,
          order_number,
          total_amount,
          shipping_address,
          payment_method,
          payment_provider,
          payment_status,
          payment_currency,
          payment_amount,
          payment_gateway_order_id,
          payment_gateway_payment_id,
          payment_gateway_signature,
          paid_at,
          notes,
          status,
          delivery_speed,
          delivery_charge
        )
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'unpaid'), $8, $9, $10, $11, $12, $13, $14, 'pending', $15, $16)
        RETURNING *
      `;

      let order = null;
      const maxRetries = 5;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const orderNumber = await this.generateOrderNumber(client, orderBase);
        try {
          const orderResult = await client.query(orderQuery, [
            user_id,
            orderNumber,
            total_amount,
            JSON.stringify(shipping_address),
            payment_method,
            payment_provider,
            payment_status,
            payment_currency,
            payment_amount,
            payment_gateway_order_id,
            payment_gateway_payment_id,
            payment_gateway_signature,
            paid_at,
            notes,
            delivery_speed,
            delivery_charge
          ]);

          order = orderResult.rows[0];
          break;
        } catch (insertError) {
          const isUniqueViolation = insertError && insertError.code === '23505';
          if (!isUniqueViolation || attempt === maxRetries - 1) {
            throw insertError;
          }
        }
      }

      if (!order) {
        throw new Error('Unable to generate unique order number');
      }

      // Create order items
      for (const item of items) {
        const itemQuery = `
          INSERT INTO order_items (order_id, product_id, product_name, quantity, price, subtotal)
          VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        await client.query(itemQuery, [
          order.id,
          item.product_id,
          item.product_name,
          item.quantity,
          item.price,
          item.subtotal
        ]);

        // Update product stock
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }

      // Clear user's cart
      await client.query('DELETE FROM cart WHERE user_id = $1', [user_id]);

      await client.query('COMMIT');
      return order;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findById(id) {
    const query = `
      SELECT o.*, 
             json_agg(
               json_build_object(
                 'id', oi.id,
                 'product_id', oi.product_id,
                 'product_name', oi.product_name,
                 'quantity', oi.quantity,
                 'price', oi.price,
                 'subtotal', oi.subtotal
               )
             ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = $1
      GROUP BY o.id
    `;
    
    const result = await db.query(query, [id]);
    return result.rows[0];
  }

  static async findByUserId(userId, filters = {}) {
    let query = `
      SELECT o.*, 
             json_agg(
               json_build_object(
                 'id', oi.id,
                 'product_id', oi.product_id,
                 'product_name', oi.product_name,
                 'quantity', oi.quantity,
                 'price', oi.price,
                 'subtotal', oi.subtotal
               )
             ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = $1
    `;

    const values = [userId];

    if (filters.status) {
      query += ` AND o.status = $2`;
      values.push(filters.status);
    }

    query += ` GROUP BY o.id ORDER BY o.created_at DESC`;

    if (filters.limit) {
      query += ` LIMIT $${values.length + 1}`;
      values.push(filters.limit);
    }

    const result = await db.query(query, values);
    return result.rows;
  }

  static async findAll(filters = {}) {
    let query = `
      SELECT o.*, u.full_name, u.email, u.phone,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', oi.id,
                   'product_id', oi.product_id,
                   'product_name', oi.product_name,
                   'quantity', oi.quantity,
                   'price', oi.price,
                   'subtotal', oi.subtotal
                 )
               ) FILTER (WHERE oi.id IS NOT NULL),
               '[]'
             ) as items
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1
    `;

    const values = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND o.status = $${paramCount}`;
      values.push(filters.status);
      paramCount++;
    }

    query += ` GROUP BY o.id, u.full_name, u.email ORDER BY o.created_at DESC`;

    if (filters.limit) {
      query += ` LIMIT $${paramCount}`;
      values.push(filters.limit);
      paramCount++;
    }

    if (filters.offset) {
      query += ` OFFSET $${paramCount}`;
      values.push(filters.offset);
    }

    const result = await db.query(query, values);
    return result.rows;
  }

  static async updateStatus(id, status) {
    const query = `
      UPDATE orders 
      SET status = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *
    `;
    const result = await db.query(query, [status, id]);
    return result.rows[0];
  }

  static async cancelById({ orderId, userId, reason = 'Customer cancelled' }) {
    const id = Number(orderId);
    if (!Number.isFinite(id)) {
      throw new Error('Invalid order id');
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(
        'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
        [id]
      );

      const order = orderResult.rows[0];
      if (!order) {
        throw new Error('Order not found');
      }

      if (Number(order.user_id) !== Number(userId)) {
        throw new Error('Access denied');
      }

      if (order.status === 'cancelled') {
        await client.query('COMMIT');
        return order;
      }

      if (order.status === 'shipped' || order.status === 'delivered') {
        throw new Error('This order can no longer be cancelled');
      }

      const itemsResult = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [id]
      );

      // Restock items (best-effort for deleted products)
      for (const row of itemsResult.rows || []) {
        const productId = row.product_id;
        const qty = Number(row.quantity) || 0;
        if (!productId || qty <= 0) continue;
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
          [qty, productId]
        );
      }

      const updateResult = await client.query(
        `
          UPDATE orders
          SET status = 'cancelled',
              cancel_reason = $1,
              cancelled_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING *
        `,
        [reason, id]
      );

      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateRefundStatus({
    orderId,
    refund_status = null,
    refund_id = null,
    refund_amount = null,
    refunded_at = null,
    payment_status = null
  }) {
    const id = Number(orderId);
    if (!Number.isFinite(id)) {
      throw new Error('Invalid order id');
    }

    const query = `
      UPDATE orders
      SET refund_status = $1,
          refund_id = $2,
          refund_amount = $3,
          refunded_at = $4,
          payment_status = COALESCE($5, payment_status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;

    const result = await db.query(query, [
      refund_status,
      refund_id,
      refund_amount,
      refunded_at,
      payment_status,
      id
    ]);

    return result.rows[0];
  }

  static async getStatistics() {
    const query = `
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_orders,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_orders,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered_orders,
        SUM(total_amount) as total_revenue,
        AVG(total_amount) as average_order_value
      FROM orders
    `;
    const result = await db.query(query);
    return result.rows[0];
  }
}

module.exports = Order;
