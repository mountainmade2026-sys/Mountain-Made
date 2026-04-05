const db = require('../config/database');
const Product = require('../models/Product');

exports.getCart = async (req, res) => {
  try {
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

    const result = await db.query(query, [req.user.id, req.user.role]);
    const cartItems = result.rows;

    const total = cartItems.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);

    res.json({
      cartItems,
      total: total.toFixed(2),
      itemCount: cartItems.length
    });
  } catch (error) {
    console.error('Get cart error:', error);
    res.status(500).json({ error: 'Failed to fetch cart.' });
  }
};

exports.addToCart = async (req, res) => {
  try {
    const { product_id, quantity } = req.body;

    if (!product_id || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'Valid product ID and quantity are required.' });
    }

    // Check if product exists and has stock
    const product = await Product.findById(product_id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    if ((product.stock_quantity || 0) <= 0) {
      return res.status(400).json({ error: 'This product is out of stock.' });
    }
    if (product.stock_quantity < quantity) {
      return res.status(400).json({ error: `Only ${product.stock_quantity} item(s) available in stock.` });
    }

    // Check if item already in cart
    const existingItem = await db.query(
      'SELECT * FROM cart WHERE user_id = $1 AND product_id = $2',
      [req.user.id, product_id]
    );

    if (existingItem.rows.length > 0) {
      // Update quantity
      const newQuantity = existingItem.rows[0].quantity + quantity;
      
      if (product.stock_quantity < newQuantity) {
        return res.status(400).json({ error: `Only ${product.stock_quantity} item(s) available in stock.` });
      }

      await db.query(
        'UPDATE cart SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND product_id = $3',
        [newQuantity, req.user.id, product_id]
      );
    } else {
      // Add new item
      await db.query(
        'INSERT INTO cart (user_id, product_id, quantity) VALUES ($1, $2, $3)',
        [req.user.id, product_id, quantity]
      );
    }

    res.json({ message: 'Product added to cart successfully.' });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({ error: 'Failed to add product to cart.' });
  }
};

exports.updateCartItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: 'Valid quantity is required.' });
    }

    // Get cart item
    const cartItem = await db.query(
      'SELECT c.*, p.stock_quantity FROM cart c JOIN products p ON c.product_id = p.id WHERE c.id = $1 AND c.user_id = $2',
      [id, req.user.id]
    );

    if (cartItem.rows.length === 0) {
      return res.status(404).json({ error: 'Cart item not found.' });
    }

    if (cartItem.rows[0].stock_quantity < quantity) {
      return res.status(400).json({ error: 'Insufficient stock available.' });
    }

    await db.query(
      'UPDATE cart SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [quantity, id]
    );

    res.json({ message: 'Cart updated successfully.' });
  } catch (error) {
    console.error('Update cart error:', error);
    res.status(500).json({ error: 'Failed to update cart.' });
  }
};

exports.removeFromCart = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'DELETE FROM cart WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cart item not found.' });
    }

    res.json({ message: 'Item removed from cart.' });
  } catch (error) {
    console.error('Remove from cart error:', error);
    res.status(500).json({ error: 'Failed to remove item from cart.' });
  }
};

exports.clearCart = async (req, res) => {
  try {
    await db.query('DELETE FROM cart WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Cart cleared successfully.' });
  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({ error: 'Failed to clear cart.' });
  }
};
