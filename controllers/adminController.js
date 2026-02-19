const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('../config/database');
const { getLicenseState, LICENSE_EXPIRED_MESSAGE } = require('../middleware/adminLicense');

// User Management
exports.getAllUsers = async (req, res) => {
  try {
    const includeSuperAdmin = req.user?.role === 'super_admin';
    const users = await User.getAllUsers({ includeSuperAdmin });
    res.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
};

exports.getWholesaleUsers = async (req, res) => {
  try {
    const users = await User.getAllWholesaleUsers();
    res.json({ users });
  } catch (error) {
    console.error('Get wholesale users error:', error);
    res.status(500).json({ error: 'Failed to fetch wholesale users.' });
  }
};

exports.approveWholesaleUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isApproved } = req.body;

    const user = await User.updateApprovalStatus(userId, isApproved);
    
    res.json({ 
      message: `User ${isApproved ? 'approved' : 'rejected'} successfully.`,
      user 
    });
  } catch (error) {
    console.error('Approve user error:', error);
    res.status(500).json({ error: 'Failed to update user approval status.' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Check if user exists
    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (['admin', 'super_admin'].includes(userCheck.rows[0].role)) {
      return res.status(400).json({ error: 'Cannot delete admin or super admin users.' });
    }
    
    // Delete user (CASCADE will handle related records)
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
};

exports.blockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isBlocked } = req.body;

    // Check if user exists
    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Prevent blocking admin/super-admin users
    if (['admin', 'super_admin'].includes(userCheck.rows[0].role)) {
      return res.status(400).json({ error: 'Cannot block admin or super admin users.' });
    }

    // Update block status
    const result = await db.query(
      'UPDATE users SET is_blocked = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, full_name, is_blocked',
      [isBlocked, userId]
    );

    res.json({ 
      message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully.`,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to update user block status.' });
  }
};

// Customer Management
exports.getAllCustomers = async (req, res) => {
  try {
    const query = `
      SELECT u.id, u.email, u.full_name, u.phone, u.role, u.is_approved, u.created_at,
             COUNT(DISTINCT o.id) as total_orders,
             COALESCE(SUM(o.total_amount), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
      WHERE u.role IN ('customer', 'wholesale')
      GROUP BY u.id, u.email, u.full_name, u.phone, u.role, u.is_approved, u.created_at
      ORDER BY u.created_at DESC
    `;
    const result = await db.query(query);
    res.json({ customers: result.rows });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers.' });
  }
};

exports.getCustomerDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get customer info
    const userQuery = await db.query(
      'SELECT id, email, full_name, phone, role, business_name, is_approved, created_at FROM users WHERE id = $1',
      [id]
    );
    
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found.' });
    }
    
    // Get customer orders with items
    const ordersQuery = await db.query(`
      SELECT o.id, o.user_id, o.total_amount, o.status, o.shipping_address, 
             o.payment_method, o.created_at, o.updated_at,
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
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [id]);
    
    res.json({ 
      customer: userQuery.rows[0],
      orders: ordersQuery.rows
    });
  } catch (error) {
    console.error('Get customer details error:', error);
    res.status(500).json({ error: 'Failed to fetch customer details.' });
  }
};

// User Activities
exports.getUserActivities = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const parsedLimit = parseInt(limit, 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;

    // Get recent user activities from orders and user registrations
    const query = `
      SELECT *
      FROM (
        SELECT 
          'order'::text        AS activity_type,
          o.id::text           AS reference_id,
          o.status::text       AS status,
          o.total_amount::numeric AS total_amount,
          o.created_at         AS created_at,
          u.id                 AS user_id,
          u.full_name          AS full_name,
          u.email              AS email
        FROM orders o
        JOIN users u ON o.user_id = u.id
        UNION ALL
        SELECT 
          'user_registered'::text AS activity_type,
          u.id::text              AS reference_id,
          NULL::text              AS status,
          NULL::numeric           AS total_amount,
          u.created_at            AS created_at,
          u.id                    AS user_id,
          u.full_name             AS full_name,
          u.email                 AS email
        FROM users u
        WHERE u.role NOT IN ('admin', 'super_admin')
      ) activities
      ORDER BY created_at DESC
      LIMIT $1
    `;

    const result = await db.query(query, [safeLimit]);
    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: 'Failed to fetch user activities.' });
  }
};

// Product Management
exports.getAllProducts = async (req, res) => {
  try {
    const products = await Product.findAll({});
    res.json({ products });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const productData = req.body;
    
    // Validate required fields
    if (!productData.name || !productData.price) {
      return res.status(400).json({ error: 'Product name and price are required.' });
    }

    const price = parseFloat(productData.price);
    const discountProvided = productData.discount_price !== undefined && productData.discount_price !== null && productData.discount_price !== '';
    const discountPrice = discountProvided ? parseFloat(productData.discount_price) : null;

    if (Number.isNaN(price)) {
      return res.status(400).json({ error: 'Price must be a valid number.' });
    }

    if (discountProvided && (Number.isNaN(discountPrice) || discountPrice < 0)) {
      return res.status(400).json({ error: 'Discount price must be a valid positive number when provided.' });
    }

    if (discountPrice !== null && discountPrice >= price) {
      return res.status(400).json({ error: 'Discount price must be less than the base price.' });
    }
    
    productData.price = price;
    productData.discount_price = discountPrice;
    
    const product = await Product.create(productData);
    
    res.status(201).json({ 
      message: 'Product created successfully.',
      product 
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: error.message || 'Failed to create product.' });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if product exists
    const existing = await Product.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    
    const incoming = req.body || {};

    const productData = {
      name: incoming.name ?? existing.name,
      description: incoming.description ?? existing.description,
      category_id: incoming.category_id ?? existing.category_id,
      homepage_section_id: incoming.homepage_section_id !== undefined ? incoming.homepage_section_id : existing.homepage_section_id,
      price: incoming.price !== undefined ? parseFloat(incoming.price) : existing.price,
      wholesale_price: incoming.wholesale_price !== undefined ? parseFloat(incoming.wholesale_price) : existing.wholesale_price,
      discount_price: incoming.discount_price !== undefined ? parseFloat(incoming.discount_price) : existing.discount_price,
      stock_quantity: incoming.stock_quantity !== undefined ? parseInt(incoming.stock_quantity, 10) : existing.stock_quantity,
      min_wholesale_qty: incoming.min_wholesale_qty !== undefined ? parseInt(incoming.min_wholesale_qty, 10) : existing.min_wholesale_qty,
      image_url: incoming.image_url ?? existing.image_url,
      images: incoming.images ?? existing.images ?? [],
      is_active: incoming.is_active ?? existing.is_active ?? true,
      weight: incoming.weight !== undefined ? incoming.weight : existing.weight,
      unit: incoming.unit ?? existing.unit
    };
    
    const product = await Product.update(id, productData);
    const hydratedProduct = product ? await Product.findById(id) : null;
    
    res.json({ 
      message: 'Product updated successfully.',
      product: hydratedProduct || product
    });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: error.message || 'Failed to update product.' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if product exists
    const existing = await Product.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    
    const product = await Product.delete(id);
    
    res.json({ message: 'Product deleted successfully.' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product.' });
  }
};

exports.updateStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;
    
    if (quantity === undefined || quantity === null) {
      return res.status(400).json({ error: 'Quantity is required.' });
    }
    
    if (quantity < 0) {
      return res.status(400).json({ error: 'Quantity cannot be negative.' });
    }
    
    const product = await Product.updateStock(id, quantity);
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    
    res.json({ 
      message: 'Stock updated successfully.',
      product 
    });
  } catch (error) {
    console.error('Update stock error:', error);
    res.status(500).json({ error: 'Failed to update stock.' });
  }
};

// Bulk Product Upload
exports.bulkUploadProducts = async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'No products provided.' });
    }
    
    const createdProducts = [];
    const errors = [];
    
    for (let i = 0; i < products.length; i++) {
      const productData = products[i];
      try {
        // Validate required fields
        if (!productData.name || !productData.price) {
          throw new Error('Product name and price are required');
        }
        
        const product = await Product.create({
          name: productData.name,
          description: productData.description || '',
          category_id: productData.category_id || 1,
          price: parseFloat(productData.price) || 0,
          wholesale_price: parseFloat(productData.wholesale_price) || null,
          stock_quantity: parseInt(productData.stock_quantity) || 0,
          min_wholesale_qty: parseInt(productData.min_wholesale_qty) || 10,
          image_url: productData.image_url || '/images/placeholder.jpg',
          weight: parseFloat(productData.weight) || 0,
          unit: productData.unit || 'kg',
          is_active: productData.is_active !== undefined ? productData.is_active : true
        });
        createdProducts.push(product);
      } catch (err) {
        errors.push({ 
          row: i + 1,
          product: productData.name || 'Unknown', 
          error: err.message 
        });
      }
    }
    
    res.status(201).json({ 
      message: `Successfully created ${createdProducts.length} of ${products.length} products.`,
      created: createdProducts.length,
      total: products.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ error: 'Failed to bulk upload products.' });
  }
};

// Category Management
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Product.getAllCategories();
    res.json({ categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const { name, description, image_url } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name is required.' });
    }
    
    const category = await Product.createCategory(name, description, image_url);
    
    res.status(201).json({ 
      message: 'Category created successfully.',
      category 
    });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: error.message || 'Failed to create category.' });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, image_url } = req.body;
    
    // Check if category exists
    const checkQuery = await db.query('SELECT id FROM categories WHERE id = $1', [id]);
    if (checkQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found.' });
    }
    
    // Update basic fields; avoid assuming optional columns like updated_at exist
    const updateQuery = `
      UPDATE categories 
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          image_url = COALESCE($3, image_url)
      WHERE id = $4
      RETURNING *
    `;
    
    const result = await db.query(updateQuery, [name, description, image_url, id]);
    
    res.json({ 
      message: 'Category updated successfully.',
      category: result.rows[0]
    });
  } catch (error) {
    console.error('Update category error:', error.message || error);
    res.status(500).json({ error: 'Failed to update category.' });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if category exists
    const categoryCheck = await db.query('SELECT id FROM categories WHERE id = $1', [id]);
    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found.' });
    }
    
    // Reassign any products with this category to NULL (uncategorized)
    await db.query('UPDATE products SET category_id = NULL WHERE category_id = $1', [id]);
    
    // Delete the category
    await db.query('DELETE FROM categories WHERE id = $1', [id]);
    res.json({ message: 'Category deleted successfully. Products have been uncategorized.' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category.' });
  }
};

// Order Management
exports.getAllOrders = async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    
    const filters = {
      status,
      limit: limit ? parseInt(limit) : null,
      offset: offset ? parseInt(offset) : null
    };

    const orders = await Order.findAll(filters);
    res.json({ orders });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders.' });
  }
};

exports.getOrderDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    
    // Get user info
    const userQuery = await db.query(
      'SELECT id, email, full_name, phone FROM users WHERE id = $1', 
      [order.user_id]
    );
    
    res.json({ 
      order,
      customer: userQuery.rows[0] || null
    });
  } catch (error) {
    console.error('Get order details error:', error);
    res.status(500).json({ error: 'Failed to fetch order details.' });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') 
      });
    }
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');
      // Lock the order row and get current status
      const existingOrderResult = await client.query(
        'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (existingOrderResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order not found.' });
      }

      const existingOrder = existingOrderResult.rows[0];
      const wasCancelled = existingOrder.status === 'cancelled';
      const willBeCancelled = status === 'cancelled';

      const updateResult = await client.query(
        `UPDATE orders 
         SET status = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 
         RETURNING *`,
        [status, id]
      );

      // If admin is newly cancelling an order, restore product stock quantities
      if (!wasCancelled && willBeCancelled) {
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

      const order = updateResult.rows[0];

      res.json({ 
        message: 'Order status updated successfully.',
        order 
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status.' });
  }
};

// Dashboard Statistics
exports.getDashboardStats = async (req, res) => {
  try {
    const orderCountQuery = await db.query('SELECT COUNT(*) as total_orders FROM orders');
    const revenueQuery = await db.query(
      "SELECT COALESCE(SUM(total_amount), 0) as total_revenue FROM orders WHERE status != 'cancelled'"
    );

    // "Spent" = estimated cost of goods sold, using products.wholesale_price as cost price
    // Profit = revenue - spent
    const spentQuery = await db.query(
      `
        SELECT COALESCE(SUM(oi.quantity * COALESCE(p.wholesale_price, 0)), 0) as total_spent
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE o.status != 'cancelled'
      `
    );

    const userCountQuery = await db.query(
      "SELECT COUNT(*) as total_customers FROM users WHERE role IN ('customer','wholesale')"
    );

    const productCountQuery = await db.query(
      'SELECT COUNT(*) as total_products FROM products WHERE is_active = true'
    );

    const stockTotalsQuery = await db.query(
      `
        SELECT
          COALESCE(SUM(stock_quantity), 0) as stock_units,
          COALESCE(SUM(stock_quantity * price), 0) as stock_value,
          COALESCE(SUM(stock_quantity * COALESCE(wholesale_price, 0)), 0) as stock_spent
        FROM products
        WHERE is_active = true
      `
    );

    const totalOrders = parseInt(orderCountQuery.rows[0]?.total_orders, 10) || 0;
    const totalRevenue = parseFloat(revenueQuery.rows[0]?.total_revenue) || 0;
    const totalSpent = parseFloat(spentQuery.rows[0]?.total_spent) || 0;
    const totalProfit = totalRevenue - totalSpent;
    const totalCustomers = parseInt(userCountQuery.rows[0]?.total_customers, 10) || 0;
    const totalProducts = parseInt(productCountQuery.rows[0]?.total_products, 10) || 0;
    const stockUnits = parseInt(stockTotalsQuery.rows[0]?.stock_units, 10) || 0;
    const stockValue = parseFloat(stockTotalsQuery.rows[0]?.stock_value) || 0;
    const stockSpent = parseFloat(stockTotalsQuery.rows[0]?.stock_spent) || 0;
    const stockProfit = stockValue - stockSpent;

    res.json({
      stats: {
        total_orders: totalOrders,
        total_revenue: totalRevenue,
        total_spent: totalSpent,
        total_profit: totalProfit,
        total_customers: totalCustomers,
        total_products: totalProducts,
        stock_units: stockUnits,
        stock_value: stockValue,
        stock_spent: stockSpent,
        stock_profit: stockProfit
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics.' });
  }
};

// Stock Reports with Movement Details
exports.getStockReports = async (req, res) => {
  try {
    // Build product summary directly from live products + orders
    // so values always stay in sync with Manage Products
    const summaryQuery = `
      SELECT 
        p.id,
        p.name,
        p.description,
        p.category_id,
        c.name as category_name,
        p.price,
        p.wholesale_price,
        p.stock_quantity as current_stock,
        p.images,
        p.is_active,
        p.created_at,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0) as total_sold,
        (p.stock_quantity + COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0)) as initial_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN order_items oi ON p.id = oi.product_id
      LEFT JOIN orders o ON oi.order_id = o.id
      WHERE p.is_active = true
      GROUP BY p.id, p.name, p.description, p.category_id, c.name, p.price, 
               p.wholesale_price, p.stock_quantity, p.images, p.is_active, p.created_at
      ORDER BY p.id ASC
    `;

    const summaryResult = await db.query(summaryQuery);
    
    // Get transaction details for each product
    const stockReports = [];
    
    for (const product of summaryResult.rows) {
      const transactionsQuery = `
        SELECT 
          o.id as order_id,
          o.order_number,
          o.created_at as order_date,
          o.status,
          u.full_name as customer_name,
          u.email as customer_email,
          oi.quantity,
          oi.price,
          oi.subtotal
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
        WHERE oi.product_id = $1
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      
      const transactionsResult = await db.query(transactionsQuery, [product.id]);
      
      stockReports.push({
        id: product.id,
        name: product.name,
        description: product.description,
        category_id: product.category_id,
        category_name: product.category_name,
        price: parseFloat(product.price),
        wholesale_price: product.wholesale_price ? parseFloat(product.wholesale_price) : null,
        current_stock: parseInt(product.current_stock) || 0,
        total_sold: parseInt(product.total_sold) || 0,
        initial_stock: parseInt(product.initial_stock) || 0,
        images: product.images,
        is_active: product.is_active,
        created_at: product.created_at,
        transactions: transactionsResult.rows.map(t => ({
          order_id: t.order_id,
          order_number: t.order_number,
          order_date: t.order_date,
          status: t.status,
          customer_name: t.customer_name,
          customer_email: t.customer_email,
          quantity: parseInt(t.quantity),
          price: parseFloat(t.price),
          subtotal: parseFloat(t.subtotal)
        }))
      });
    }

    res.json({ stockReports });
  } catch (error) {
    console.error('Get stock reports error:', error);
    res.status(500).json({ error: 'Failed to fetch stock reports.' });
  }
};

// Stock Statements with Transaction History
exports.getStockStatements = async (req, res) => {
  try {
    const { period } = req.query;
    
    // Build date filter based on period
    let dateFilter = '';
    if (period === 'today') {
      dateFilter = "AND o.created_at >= CURRENT_DATE";
    } else if (period === 'week') {
      dateFilter = "AND o.created_at >= CURRENT_DATE - INTERVAL '7 days'";
    } else if (period === 'month') {
      dateFilter = "AND o.created_at >= CURRENT_DATE - INTERVAL '30 days'";
    } else if (period === 'year') {
      dateFilter = "AND o.created_at >= CURRENT_DATE - INTERVAL '1 year'";
    }

    // Get product summary with stock information
    const summaryQuery = `
      SELECT 
        p.id,
        p.name,
        p.description,
        p.category_id,
        c.name as category_name,
        p.price,
        p.wholesale_price,
        p.stock_quantity as current_stock,
        p.images,
        p.is_active,
        p.created_at,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0) as total_sold,
        (p.stock_quantity + COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0)) as initial_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN order_items oi ON p.id = oi.product_id
      LEFT JOIN orders o ON oi.order_id = o.id
      WHERE p.is_active = true ${dateFilter}
      GROUP BY p.id, p.name, p.description, p.category_id, c.name, p.price, 
               p.wholesale_price, p.stock_quantity, p.images, p.is_active, p.created_at
      ORDER BY p.id ASC
    `;
    
    const summaryResult = await db.query(summaryQuery);
    
    // Get transaction details for each product
    const statements = [];
    
    for (const product of summaryResult.rows) {
      const transactionsQuery = `
        SELECT 
          o.id as order_id,
          o.order_number,
          o.created_at as order_date,
          o.status,
          u.full_name as customer_name,
          u.email as customer_email,
          oi.quantity,
          oi.price,
          oi.subtotal
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
        WHERE oi.product_id = $1 ${dateFilter}
        ORDER BY o.created_at DESC
      `;
      
      const transactionsResult = await db.query(transactionsQuery, [product.id]);
      
      statements.push({
        id: product.id,
        name: product.name,
        description: product.description,
        category_id: product.category_id,
        category_name: product.category_name,
        price: parseFloat(product.price),
        wholesale_price: product.wholesale_price ? parseFloat(product.wholesale_price) : null,
        current_stock: parseInt(product.current_stock) || 0,
        total_sold: parseInt(product.total_sold) || 0,
        initial_stock: parseInt(product.initial_stock) || 0,
        images: product.images,
        is_active: product.is_active,
        created_at: product.created_at,
        transactions: transactionsResult.rows.map(t => ({
          order_id: t.order_id,
          order_number: t.order_number,
          order_date: t.order_date,
          status: t.status,
          customer_name: t.customer_name,
          customer_email: t.customer_email,
          quantity: parseInt(t.quantity),
          price: parseFloat(t.price),
          subtotal: parseFloat(t.subtotal)
        }))
      });
    }

    res.json({ statements });
  } catch (error) {
    console.error('Get stock statements error:', error);
    res.status(500).json({ error: 'Failed to fetch stock statements.' });
  }
};

// Homepage Sections Management
exports.getAllHomepageSections = async (req, res) => {
  try {
    const query = 'SELECT * FROM homepage_sections ORDER BY sort_order ASC, created_at ASC';
    const result = await db.query(query);
    res.json({ sections: result.rows });
  } catch (error) {
    console.error('Get homepage sections error:', error);
    res.status(500).json({ error: 'Failed to fetch homepage sections.' });
  }
};

exports.createHomepageSection = async (req, res) => {
  try {
    const { name, description, sort_order, heading_image_url } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Section name is required.' });
    }
    
    const query = `
      INSERT INTO homepage_sections (name, description, heading_image_url, sort_order, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING *
    `;
    
    const result = await db.query(query, [
      name,
      description || null,
      heading_image_url || null,
      sort_order || 0
    ]);
    
    res.status(201).json({ 
      message: 'Homepage section created successfully.',
      section: result.rows[0]
    });
  } catch (error) {
    console.error('Create homepage section error:', error);
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ error: 'A section with this name already exists.' });
    } else {
      res.status(500).json({ error: 'Failed to create homepage section.' });
    }
  }
};

exports.updateHomepageSection = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, heading_image_url, sort_order, is_active } = req.body;
    
    const query = `
      UPDATE homepage_sections 
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          heading_image_url = COALESCE($3, heading_image_url),
          sort_order = COALESCE($4, sort_order),
          is_active = COALESCE($5, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;
    
    const result = await db.query(query, [name, description, heading_image_url, sort_order, is_active, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Homepage section not found.' });
    }
    
    res.json({ 
      message: 'Homepage section updated successfully.',
      section: result.rows[0]
    });
  } catch (error) {
    console.error('Update homepage section error:', error);
    res.status(500).json({ error: 'Failed to update homepage section.' });
  }
};

exports.deleteHomepageSection = async (req, res) => {
  try {
    const { id } = req.params;
    
    // First, unassign any products using this section
    await db.query('UPDATE products SET homepage_section_id = NULL WHERE homepage_section_id = $1', [id]);
    
    // Then delete the section
    const result = await db.query('DELETE FROM homepage_sections WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Homepage section not found.' });
    }
    
    res.json({ message: 'Homepage section deleted successfully. Products have been unassigned.' });
  } catch (error) {
    console.error('Delete homepage section error:', error);
    res.status(500).json({ error: 'Failed to delete homepage section.' });
  }
};

exports.getHomepageSectionsWithProducts = async (req, res) => {
  try {
    const query = `
      SELECT 
        hs.id,
        hs.name,
        hs.description,
        hs.sort_order,
        hs.is_active,
        json_agg(
          json_build_object(
            'id', p.id,
            'name', p.name,
            'description', p.description,
            'price', p.price,
            'wholesale_price', p.wholesale_price,
            'stock_quantity', p.stock_quantity,
            'image_url', p.image_url,
            'images', p.images,
            'unit', p.unit,
            'category_id', p.category_id,
            'min_wholesale_qty', p.min_wholesale_qty
          ) ORDER BY p.created_at DESC
        ) FILTER (WHERE p.id IS NOT NULL) as products
      FROM homepage_sections hs
      LEFT JOIN products p ON hs.id = p.homepage_section_id AND p.is_active = true
      WHERE hs.is_active = true
      GROUP BY hs.id, hs.name, hs.description, hs.sort_order, hs.is_active
      ORDER BY hs.sort_order ASC, hs.created_at ASC
    `;
    
    const result = await db.query(query);
    res.json({ sections: result.rows });
  } catch (error) {
    console.error('Get homepage sections with products error:', error);
    res.status(500).json({ error: 'Failed to fetch homepage sections with products.' });
  }
};

// Site Settings Management
exports.getSiteSettings = async (req, res) => {
  try {
    const result = await db.query('SELECT setting_key, setting_value FROM site_settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });
    res.json({ settings });
  } catch (error) {
    console.error('Get site settings error:', error);
    res.status(500).json({ error: 'Failed to fetch site settings.' });
  }
};

exports.getAdminLicenseStatus = async (req, res) => {
  try {
    const license = await getLicenseState();
    const expiresAtMs = license.expiresAt ? new Date(license.expiresAt).getTime() : null;
    const remainingMs = expiresAtMs ? Math.max(0, expiresAtMs - Date.now()) : null;

    res.json({
      license: {
        ...license,
        remainingMs,
        message: license.isBlocked ? LICENSE_EXPIRED_MESSAGE : 'License is active.'
      }
    });
  } catch (error) {
    console.error('Get admin license status error:', error);
    res.status(500).json({ error: 'Failed to fetch admin license status.' });
  }
};

exports.updateAdminLicense = async (req, res) => {
  try {
    const {
      manual_blocked,
      expires_at,
      clear_expiry
    } = req.body || {};

    const updates = [];

    if (manual_blocked !== undefined) {
      const blockedValue =
        typeof manual_blocked === 'boolean'
          ? manual_blocked
          : String(manual_blocked).toLowerCase() === 'true';
      updates.push({ key: 'admin_license_blocked', value: blockedValue ? 'true' : 'false' });
    }

    if (clear_expiry === true || String(clear_expiry).toLowerCase() === 'true') {
      updates.push({ key: 'admin_license_expires_at', value: '' });
    } else if (expires_at !== undefined) {
      const parsed = new Date(expires_at);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'Invalid expiry date/time.' });
      }
      updates.push({ key: 'admin_license_expires_at', value: parsed.toISOString() });
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No license fields were provided.' });
    }

    for (const setting of updates) {
      await db.query(
        `
          INSERT INTO site_settings (setting_key, setting_value)
          VALUES ($1, $2)
          ON CONFLICT (setting_key)
          DO UPDATE SET
            setting_value = EXCLUDED.setting_value,
            updated_at = CURRENT_TIMESTAMP
        `,
        [setting.key, setting.value]
      );
    }

    const license = await getLicenseState();
    const expiresAtMs = license.expiresAt ? new Date(license.expiresAt).getTime() : null;
    const remainingMs = expiresAtMs ? Math.max(0, expiresAtMs - Date.now()) : null;

    res.json({
      success: true,
      message: 'Admin license updated successfully.',
      license: {
        ...license,
        remainingMs,
        message: license.isBlocked ? LICENSE_EXPIRED_MESSAGE : 'License is active.'
      }
    });
  } catch (error) {
    console.error('Update admin license error:', error);
    res.status(500).json({ error: 'Failed to update admin license.' });
  }
};

exports.updateSiteSettings = async (req, res) => {
  try {
    // Temporary debug log to help trace incoming payload shape
    console.log('updateSiteSettings payload:', req.body);

    const {
      logo_url,
      homepage_hero_title,
      homepage_hero_subtitle,
      homepage_hero_image_url,
      homepage_hero_section_id,
      business_support_email,
      admin_license_blocked,
      admin_license_expires_at,
      fast_delivery_enabled,
      fast_delivery_charge
    } = req.body || {};

    const hasLicenseChange =
      admin_license_blocked !== undefined ||
      admin_license_expires_at !== undefined;

    if (hasLicenseChange && req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can manage admin license settings.' });
    }

    // Collect all provided settings so this endpoint can be reused
    // for logo and any homepage text headings.
    const updates = [];

    if (logo_url !== undefined) {
      updates.push({ key: 'logo_url', value: logo_url });
    }
    if (homepage_hero_title !== undefined) {
      updates.push({ key: 'homepage_hero_title', value: homepage_hero_title });
    }
    if (homepage_hero_subtitle !== undefined) {
      updates.push({ key: 'homepage_hero_subtitle', value: homepage_hero_subtitle });
    }
    if (homepage_hero_image_url !== undefined) {
      updates.push({ key: 'homepage_hero_image_url', value: homepage_hero_image_url });
    }
    if (homepage_hero_section_id !== undefined) {
      updates.push({ key: 'homepage_hero_section_id', value: homepage_hero_section_id });
    }
    if (business_support_email !== undefined) {
      const emailValue = String(business_support_email || '').trim();
      if (emailValue && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
        return res.status(400).json({ error: 'Business support email must be a valid email address.' });
      }
      updates.push({ key: 'business_support_email', value: emailValue });
    }
    if (admin_license_blocked !== undefined) {
      const blockedValue =
        typeof admin_license_blocked === 'boolean'
          ? admin_license_blocked
          : String(admin_license_blocked).toLowerCase() === 'true';
      updates.push({ key: 'admin_license_blocked', value: blockedValue ? 'true' : 'false' });
    }
    if (admin_license_expires_at !== undefined) {
      if (admin_license_expires_at === null || admin_license_expires_at === '') {
        updates.push({ key: 'admin_license_expires_at', value: '' });
      } else {
        const parsedExpiry = new Date(admin_license_expires_at);
        if (Number.isNaN(parsedExpiry.getTime())) {
          return res.status(400).json({ error: 'Invalid admin license expiry date/time.' });
        }
        updates.push({ key: 'admin_license_expires_at', value: parsedExpiry.toISOString() });
      }
    }

    // Fast delivery toggle (stored as 'true'/'false' string for simplicity)
    // Accept null/undefined as "not provided", but 0 and false are valid values
    if (fast_delivery_enabled !== undefined && fast_delivery_enabled !== null) {
      const enabledValue =
        typeof fast_delivery_enabled === 'boolean'
          ? fast_delivery_enabled
          : String(fast_delivery_enabled).toLowerCase() === 'true';
      updates.push({ key: 'fast_delivery_enabled', value: enabledValue ? 'true' : 'false' });
    }

    // Fast delivery charge (validate numeric and non-negative)
    // Accept 0 as a valid value (free fast delivery), but not null/undefined
    if (fast_delivery_charge !== undefined && fast_delivery_charge !== null) {
      const parsed = parseFloat(fast_delivery_charge);
      if (Number.isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'Fast delivery charge must be a valid non-negative number.' });
      }
      updates.push({ key: 'fast_delivery_charge', value: parsed.toFixed(2) });
    }

    if (updates.length === 0) {
      // If nothing was provided, respond gracefully instead of erroring
      return res.json({ success: true, message: 'No changes to update.' });
    }

    for (const setting of updates) {
      await db.query(
        `
        INSERT INTO site_settings (setting_key, setting_value)
        VALUES ($1, $2)
        ON CONFLICT (setting_key)
        DO UPDATE SET
          setting_value = EXCLUDED.setting_value,
          updated_at = CURRENT_TIMESTAMP
        `,
        [setting.key, setting.value]
      );
    }

    res.json({ 
      success: true,
      message: 'Site settings updated successfully.'
    });
  } catch (error) {
    console.error('Update site settings error:', error);
    res.status(500).json({ error: 'Failed to update site settings.' });
  }
};

// Support: Messages & Complaints
exports.getContactMessages = async (req, res) => {
  try {
    const { unread, limit = 100 } = req.query;
    const parsedLimit = parseInt(limit, 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 100;

    const unreadFilter = String(unread || '').trim().toLowerCase();
    const unreadOnly = unreadFilter === '1' || unreadFilter === 'true' || unreadFilter === 'yes';

    const query = `
      SELECT
        cm.id,
        cm.message_type,
        cm.full_name,
        cm.email,
        cm.phone,
        cm.subject,
        cm.message,
        cm.source_page,
        cm.is_read,
        cm.email_forwarded,
        cm.email_forwarded_at,
        cm.forwarded_to,
        cm.email_forward_error,
        cm.created_at,
        u.id AS user_id,
        u.role AS user_role,
        u.email AS user_email
      FROM contact_messages cm
      LEFT JOIN users u ON cm.user_id = u.id
      WHERE cm.message_type = 'message'
        AND ($1::boolean IS FALSE OR cm.is_read = FALSE)
      ORDER BY cm.created_at DESC
      LIMIT $2
    `;

    const result = await db.query(query, [unreadOnly, safeLimit]);
    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Get contact messages error:', error);
    res.status(500).json({ error: 'Failed to fetch contact messages.' });
  }
};

exports.getContactUnreadCounts = async (req, res) => {
  try {
    const result = await db.query(
      `
        SELECT message_type, COUNT(*)::int AS unread_count
        FROM contact_messages
        WHERE is_read = FALSE
        GROUP BY message_type
      `
    );

    const counts = { message: 0, complaint: 0 };
    for (const row of result.rows || []) {
      const type = String(row.message_type || '').toLowerCase();
      if (type === 'complaint' || type === 'message') {
        counts[type] = Number.isFinite(Number(row.unread_count)) ? Number(row.unread_count) : 0;
      }
    }

    res.json({ counts });
  } catch (error) {
    console.error('Get contact unread counts error:', error);
    res.status(500).json({ error: 'Failed to fetch unread counts.' });
  }
};

exports.markContactMessageRead = async (req, res) => {
  try {
    const { id } = req.params;
    const parsedId = parseInt(id, 10);
    if (!Number.isFinite(parsedId)) {
      return res.status(400).json({ error: 'Invalid message id.' });
    }

    const { is_read = true } = req.body || {};
    const value = !!is_read;

    const result = await db.query(
      'UPDATE contact_messages SET is_read = $1 WHERE id = $2 RETURNING id, is_read',
      [value, parsedId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    res.json({ message: 'Updated.', record: result.rows[0] });
  } catch (error) {
    console.error('Mark contact message read error:', error);
    res.status(500).json({ error: 'Failed to update message.' });
  }
};

exports.sendContactMessageToBusinessEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const parsedId = parseInt(id, 10);
    if (!Number.isFinite(parsedId)) {
      return res.status(400).json({ error: 'Invalid message id.' });
    }

    const messageResult = await db.query(
      `
        SELECT id, full_name, email, phone, subject, message, created_at
        FROM contact_messages
        WHERE id = $1
      `,
      [parsedId]
    );

    if (!messageResult.rows.length) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    const messageRow = messageResult.rows[0];

    const smtpHost = String(process.env.SMTP_HOST || '').trim();
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpUser = String(process.env.SMTP_USER || '').trim();
    const smtpPass = String(process.env.SMTP_PASS || '').trim();
    const businessEmail = String(process.env.BUSINESS_SUPPORT_EMAIL || '').trim() || smtpUser;
    const fromEmail = String(process.env.SMTP_FROM_EMAIL || '').trim() || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass || !businessEmail || !fromEmail) {
      return res.status(503).json({
        error: 'Business email integration is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM_EMAIL, BUSINESS_SUPPORT_EMAIL.'
      });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number.isFinite(smtpPort) ? smtpPort : 587,
      secure: Number(smtpPort) === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    const subjectLine = `Customer Message #${messageRow.id} - ${messageRow.subject || 'No Subject'}`;
    const textBody = [
      `Message ID: ${messageRow.id}`,
      `Date: ${messageRow.created_at}`,
      `From: ${messageRow.full_name || '-'}`,
      `Customer Email: ${messageRow.email || '-'}`,
      `Phone: ${messageRow.phone || '-'}`,
      `Subject: ${messageRow.subject || '-'}`,
      '',
      'Message:',
      messageRow.message || '-'
    ].join('\n');

    await transporter.sendMail({
      from: fromEmail,
      to: businessEmail,
      replyTo: messageRow.email || undefined,
      subject: subjectLine,
      text: textBody
    });

    return res.json({
      message: 'Message forwarded to business email successfully.',
      recipient: businessEmail
    });
  } catch (error) {
    console.error('Send contact message to business email error:', error);
    return res.status(500).json({ error: 'Failed to send to business email.' });
  }
};

// Danger Zone: delete (reset) all non-admin data
exports.deleteAllData = async (req, res) => {
  try {
    const { confirmation } = req.body || {};

    // Simple but strong confirmation phrase
    if (confirmation !== 'DELETE ALL DATA') {
      return res.status(400).json({
        error: 'Invalid confirmation phrase.',
      });
    }

    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Dynamically truncate all public tables except users, then remove non-admin users.
      // This avoids missing any new tables added later.
      const tablesResult = await client.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> 'users'
      `);

      const tableNames = tablesResult.rows.map(r => r.tablename);
      if (tableNames.length > 0) {
        const tableList = tableNames
          .map(name => `"public"."${name.replace(/"/g, '""')}"`)
          .join(', ');

        await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
      }

      // Delete all non-admin users (customers, wholesale, etc.)
      await client.query(`DELETE FROM users WHERE role NOT IN ('admin', 'super_admin')`);

      // Ensure any remaining admin/super-admin accounts stay active
      await client.query(`
        UPDATE users
        SET is_approved = true,
            is_blocked = false,
            updated_at = CURRENT_TIMESTAMP
        WHERE role IN ('admin', 'super_admin')
      `);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const verifyResult = await db.query(`
      SELECT
        current_database() AS database_name,
        current_user AS database_user,
        inet_server_addr()::text AS server_addr,
        inet_server_port() AS server_port,
        COUNT(*)::int AS users_total,
        COUNT(*) FILTER (WHERE role = 'admin')::int AS admin_users,
        COUNT(*) FILTER (WHERE role = 'super_admin')::int AS super_admin_users,
        COUNT(*) FILTER (WHERE role NOT IN ('admin','super_admin'))::int AS non_admin_users
      FROM users
    `);

    res.json({
      message: 'All non-admin data has been permanently deleted.',
      verification: verifyResult.rows[0]
    });
  } catch (error) {
    console.error('Delete all data error:', error);
    res.status(500).json({ error: 'Failed to delete all data.' });
  }
};
