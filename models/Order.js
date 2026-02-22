const db = require('../config/database');

class Order {
  static buildOrderNumberBase(date = new Date()) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `MM${day}${month}${year}`;
  }

  static async generateOrderNumber(client, base) {
    const query = `
      SELECT order_number
      FROM orders
      WHERE order_number = $1 OR order_number LIKE $2
    `;

    const result = await client.query(query, [base, `${base}-%`]);
    const existing = result.rows.map(r => String(r.order_number || '').trim()).filter(Boolean);

    if (!existing.includes(base)) {
      return base;
    }

    let maxSuffix = 1;
    for (const orderNumber of existing) {
      const match = orderNumber.match(new RegExp(`^${base}-(\\d+)$`));
      if (!match) continue;
      const suffixValue = parseInt(match[1], 10);
      if (Number.isFinite(suffixValue) && suffixValue > maxSuffix) {
        maxSuffix = suffixValue;
      }
    }

    return `${base}-${maxSuffix + 1}`;
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
        notes,
        items,
        delivery_speed = null,
        delivery_charge = 0
      } = orderData;
      
      // Generate unique business order number (MMDDMMYYYY, then MMDDMMYYYY-2, -3... if needed)
      const orderBase = this.buildOrderNumberBase(new Date());
      const orderQuery = `
        INSERT INTO orders (
          user_id,
          order_number,
          total_amount,
          shipping_address,
          payment_method,
          notes,
          status,
          delivery_speed,
          delivery_charge
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
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
      SELECT o.*, u.full_name, u.email,
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
