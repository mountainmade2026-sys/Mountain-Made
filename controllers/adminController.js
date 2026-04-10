const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const https = require('https');
const db = require('../config/database');
const { getLicenseState, LICENSE_EXPIRED_MESSAGE } = require('../middleware/adminLicense');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER || '';
const TWILIO_WHATSAPP_FROM_NUMBER = process.env.TWILIO_WHATSAPP_FROM_NUMBER || process.env.TWILIO_WHATSAPP_NUMBER || '';

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

const EMAIL_SEND_TIMEOUT_MS = 20000;
const SMS_SEND_TIMEOUT_MS = 20000;
const WHATSAPP_SEND_TIMEOUT_MS = 20000;
const SMS_CONCURRENCY = 8;
const WHATSAPP_CONCURRENCY = 8;
const EMAIL_BCC_CHUNK_SIZE = 40;
let adminMessageHistoryTableReady = false;

function canUseResendForAdmin() {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM_EMAIL || '').trim();
  return !!key && !!from;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').trim();
}

function toWhatsappAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (raw.toLowerCase().startsWith('whatsapp:')) {
    return raw;
  }

  const cleaned = raw.replace(/[\s()-]/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('+')) {
    return `whatsapp:${cleaned}`;
  }

  if (/^\d+$/.test(cleaned)) {
    return `whatsapp:+${cleaned}`;
  }

  return '';
}

function getSmtpConfig() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').trim();
  const fromEmail = String(process.env.SMTP_FROM_EMAIL || '').trim() || smtpUser;

  return {
    smtpHost,
    smtpPort: Number.isFinite(smtpPort) ? smtpPort : 587,
    smtpUser,
    smtpPass,
    fromEmail
  };
}

function createSmtpTransporterOrThrow() {
  const { smtpHost, smtpPort, smtpUser, smtpPass } = getSmtpConfig();
  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error('Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM_EMAIL.');
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: Number(smtpPort) === 465,
    auth: { user: smtpUser, pass: smtpPass },
    pool: true,
    maxConnections: 5,
    maxMessages: 200,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function httpJsonRequest({ method, hostname, path, headers, body }) {
  const payload = body ? JSON.stringify(body) : '';
  const requestHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...(headers || {})
  };

  return new Promise((resolve, reject) => {
    const req = https.request({ method: method || 'POST', hostname, path, headers: requestHeaders }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        if (statusCode >= 200 && statusCode < 300) {
          return resolve();
        }
        return reject(new Error(data || `HTTP ${statusCode}`));
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendViaResend({ toList, subject, message }) {
  if (!canUseResendForAdmin()) {
    throw new Error('Resend is not configured.');
  }

  const recipients = (toList || []).filter(Boolean);
  if (!recipients.length) {
    return;
  }

  await httpJsonRequest({
    method: 'POST',
    hostname: 'api.resend.com',
    path: '/emails',
    headers: {
      Authorization: `Bearer ${String(process.env.RESEND_API_KEY || '').trim()}`
    },
    body: {
      from: String(process.env.RESEND_FROM_EMAIL || '').trim(),
      to: recipients,
      subject: subject || 'Message from Mount Made',
      text: message
    }
  });
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage || 'Operation timed out.'));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function chunkArray(items, size) {
  const safeSize = Math.max(1, size || 1);
  const chunks = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

async function runWithConcurrency(items, concurrency, handler) {
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      await handler(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(safeConcurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

async function getMessageRecipients({ audience, identifierType, identifier }) {
  const safeAudience = String(audience || '').trim().toLowerCase();
  const safeIdentifierType = String(identifierType || '').trim().toLowerCase();
  const safeIdentifier = String(identifier || '').trim();

  if (safeAudience === 'single') {
    if (!safeIdentifier) {
      throw new Error('Please provide a user email or id.');
    }

    if (safeIdentifierType === 'id') {
      const parsedId = parseInt(safeIdentifier, 10);
      if (Number.isFinite(parsedId)) {
        const result = await db.query(
          `
            SELECT id, email, full_name, phone, role, is_blocked
            FROM users
            WHERE id = $1
              AND role IN ('customer', 'wholesale')
            LIMIT 1
          `,
          [parsedId]
        );
        return result.rows;
      }

      // Fallback: allow pasted email/value even when "id" is selected
      const fallbackEmail = normalizeEmail(safeIdentifier);
      if (!fallbackEmail) {
        throw new Error('Invalid user id.');
      }

      const fallbackResult = await db.query(
        `
          SELECT id, email, full_name, phone, role, is_blocked
          FROM users
          WHERE LOWER(email) = LOWER($1)
            AND role IN ('customer', 'wholesale')
          LIMIT 1
        `,
        [fallbackEmail]
      );
      return fallbackResult.rows;
    }

    // default to email
    const email = normalizeEmail(safeIdentifier);
    if (!email) {
      throw new Error('Invalid email.');
    }

    const result = await db.query(
      `
        SELECT id, email, full_name, phone, role, is_blocked
        FROM users
        WHERE LOWER(email) = LOWER($1)
          AND role IN ('customer', 'wholesale')
        LIMIT 1
      `,
      [email]
    );
    return result.rows;
  }

  const whereRole = (() => {
    if (safeAudience === 'customers') return "role = 'customer'";
    if (safeAudience === 'wholesale') return "role = 'wholesale'";
    // all users
    return "role IN ('customer', 'wholesale')";
  })();

  const result = await db.query(
    `
      SELECT id, email, full_name, phone, role, is_blocked
      FROM users
      WHERE ${whereRole}
      ORDER BY id ASC
    `
  );
  return result.rows;
}

async function ensureAdminMessageHistoryTable() {
  if (adminMessageHistoryTableReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_message_history (
      id SERIAL PRIMARY KEY,
      admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      audience VARCHAR(20) NOT NULL,
      identifier_type VARCHAR(20),
      identifier TEXT,
      subject TEXT,
      message_body TEXT NOT NULL,
      channels JSONB NOT NULL DEFAULT '{}'::jsonb,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  adminMessageHistoryTableReady = true;
}

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

    // Get recent user activities from orders, returns, and user registrations
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
          'return'::text           AS activity_type,
          COALESCE(r.return_number, r.id::text) AS reference_id,
          r.status::text           AS status,
          r.refund_amount::numeric AS total_amount,
          r.updated_at             AS created_at,
          u.id                     AS user_id,
          u.full_name              AS full_name,
          u.email                  AS email
        FROM returns r
        JOIN users u ON r.user_id = u.id
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

    if (productData.discount_adjust !== undefined) {
      const rawAdjust = productData.discount_adjust;
      const trimmed = rawAdjust === null ? '' : String(rawAdjust).trim();
      productData.discount_adjust = trimmed ? trimmed : null;
    }
    
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
      wholesale_price: incoming.wholesale_price !== undefined
        ? (incoming.wholesale_price === null ? null : parseFloat(incoming.wholesale_price))
        : existing.wholesale_price,
      discount_price: incoming.discount_price !== undefined
        ? (incoming.discount_price === null ? null : parseFloat(incoming.discount_price))
        : existing.discount_price,
      discount_adjust: incoming.discount_adjust !== undefined
        ? (incoming.discount_adjust === null ? null : String(incoming.discount_adjust).trim() || null)
        : existing.discount_adjust,
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

    // Extract upload IDs from image URLs before deleting
    const imageUrls = [
      ...(existing.images || []),
      existing.image_url
    ].filter(Boolean);
    const uploadIds = imageUrls
      .map(url => { const m = String(url).match(/^\/uploads\/(\d+)$/); return m ? parseInt(m[1], 10) : null; })
      .filter(Boolean);
    
    const product = await Product.delete(id);

    // Delete orphaned upload rows so old images can't reappear
    if (uploadIds.length > 0) {
      await db.query(`DELETE FROM uploads WHERE id = ANY($1::int[])`, [uploadIds]);
    }
    
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

// Dashboard History (orders grouped by day, filterable by date range or year)
exports.getDashboardHistory = async (req, res) => {
  try {
    const { from, to, year } = req.query;
    const params = [];
    const conditions = ["o.status != 'cancelled'"];

    if (from && to) {
      params.push(from, to);
      conditions.push(`o.created_at::date >= $${params.length - 1} AND o.created_at::date <= $${params.length}`);
    } else if (year) {
      const y = parseInt(year, 10);
      if (!isNaN(y)) {
        params.push(y);
        conditions.push(`EXTRACT(YEAR FROM o.created_at) = $${params.length}`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rowsResult = await db.query(`
      SELECT
        o.created_at::date                                     AS date,
        COUNT(DISTINCT o.id)                                   AS orders,
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'delivered'), 0) AS revenue,
        COALESCE(SUM(oi.quantity * COALESCE(p.wholesale_price, 0)) FILTER (WHERE o.status = 'delivered'), 0) AS cost,
        COALESCE(SUM(o.delivery_charge) FILTER (WHERE o.status = 'delivered'), 0) AS delivery_fees
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.id = oi.product_id
      ${where}
      GROUP BY o.created_at::date
      ORDER BY o.created_at::date DESC
    `, params);

    const refundWhere = from && to
      ? `AND r.processed_at::date >= '${from}' AND r.processed_at::date <= '${to}'`
      : year && !isNaN(parseInt(year, 10))
        ? `AND EXTRACT(YEAR FROM r.processed_at) = ${parseInt(year, 10)}`
        : '';
    const refundResult = await db.query(
      `SELECT COALESCE(SUM(r.refund_amount), 0) AS total_refunds FROM returns r WHERE r.status = 'refunded' ${refundWhere}`
    );
    const totalRefunds = parseFloat(refundResult.rows[0]?.total_refunds) || 0;

    const rows = rowsResult.rows.map(r => ({
      date: r.date,
      orders: parseInt(r.orders) || 0,
      revenue: parseFloat(r.revenue) || 0,
      cost: parseFloat(r.cost) || 0,
      delivery_fees: parseFloat(r.delivery_fees) || 0,
      profit: (parseFloat(r.revenue) || 0) - (parseFloat(r.cost) || 0)
    }));

    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0) - totalRefunds;
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
    const totalDelivery = rows.reduce((s, r) => s + r.delivery_fees, 0);

    res.json({
      rows,
      summary: {
        total_orders: totalOrders,
        total_revenue: totalRevenue,
        total_cost: totalCost,
        total_profit: totalRevenue - totalCost,
        total_delivery_fees: totalDelivery,
        total_refunds: totalRefunds
      }
    });
  } catch (error) {
    console.error('Get dashboard history error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard history.' });
  }
};

// Dashboard Statistics
exports.getDashboardStats = async (req, res) => {
  try {
    const orderCountQuery = await db.query('SELECT COUNT(*) as total_orders FROM orders');

    // Revenue = only delivered orders (customer actually received the product)
    // Subtract refunded return amounts
    const revenueQuery = await db.query(`
      SELECT
        COALESCE(SUM(o.total_amount), 0)
          - COALESCE((
              SELECT SUM(r.refund_amount)
              FROM returns r
              WHERE r.status = 'refunded' AND r.refund_amount IS NOT NULL
            ), 0)
        AS total_revenue
      FROM orders o
      WHERE o.status = 'delivered'
    `);

    // Cost (spent) = wholesale cost of delivered items only, minus returned items
    const spentQuery = await db.query(`
      SELECT
        COALESCE(SUM(oi.quantity * COALESCE(p.wholesale_price, 0)), 0)
          - COALESCE((
              SELECT SUM(ri.quantity * COALESCE(p2.wholesale_price, 0))
              FROM return_items ri
              JOIN returns r ON r.id = ri.return_id
              LEFT JOIN products p2 ON p2.id = ri.product_id
              WHERE r.status = 'refunded'
            ), 0)
        AS total_spent
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.status = 'delivered'
    `);

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
    const rawQuery = String(req.query?.q || req.query?.query || req.query?.search || '').trim();
    const rawStatus = String(req.query?.status || '').trim();
    const rawCategoryId = String(req.query?.category_id || req.query?.categoryId || '').trim();

    const queryForText = rawQuery
      .replace(/^\s*id\s*[:#\-]?\s*/i, '')
      .replace(/^\s*#\s*/, '')
      .trim();

    const likeText = queryForText ? `%${queryForText}%` : null;
    const queryDigits = rawQuery.replace(/[^0-9]/g, '').trim();
    const likeId = queryDigits ? `%${queryDigits}%` : null;

    const categoryId = /^[0-9]+$/.test(rawCategoryId) ? parseInt(rawCategoryId, 10) : null;

    const where = ['p.is_active = true'];
    const params = [];

    if (categoryId) {
      params.push(categoryId);
      where.push(`p.category_id = $${params.length}`);
    }

    if (rawStatus === 'in-stock') {
      where.push('p.stock_quantity > 10');
    } else if (rawStatus === 'low-stock') {
      where.push('p.stock_quantity > 0 AND p.stock_quantity <= 10');
    } else if (rawStatus === 'out-of-stock') {
      where.push('p.stock_quantity <= 0');
    }

    if (likeText || likeId) {
      if (likeText && likeId) {
        params.push(likeText);
        const textParam = `$${params.length}`;
        params.push(likeId);
        const idParam = `$${params.length}`;
        where.push(`(p.name ILIKE ${textParam} OR c.name ILIKE ${textParam} OR p.id::text ILIKE ${idParam})`);
      } else {
        const oneLike = likeText || likeId;
        params.push(oneLike);
        const oneParam = `$${params.length}`;
        where.push(`(p.name ILIKE ${oneParam} OR c.name ILIKE ${oneParam} OR p.id::text ILIKE ${oneParam})`);
      }
    }

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
        -- total_sold: all non-cancelled (for stock tracking purposes)
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0) as total_sold,
        (p.stock_quantity + COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0)) as initial_stock,
        -- revenue: only delivered orders (customer actually received & paid)
        COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN oi.subtotal ELSE 0 END), 0) as total_revenue,
        -- cost: wholesale price of delivered items
        COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN oi.quantity * COALESCE(p.wholesale_price, 0) ELSE 0 END), 0) as total_cost
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN order_items oi ON p.id = oi.product_id
      LEFT JOIN orders o ON oi.order_id = o.id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id, p.name, p.description, p.category_id, c.name, p.price, 
               p.wholesale_price, p.stock_quantity, p.images, p.is_active, p.created_at
      ORDER BY p.id ASC
    `;

    const summaryResult = await db.query(summaryQuery, params);
    
    // Get transaction details for each product
    const stockReports = [];
    
    for (const product of summaryResult.rows) {
      const transactionsQuery = `
        SELECT
          'sale'           AS type,
          o.id             AS order_id,
          o.order_number,
          o.created_at     AS order_date,
          o.status,
          o.delivery_speed,
          o.delivery_charge,
          u.full_name      AS customer_name,
          u.email          AS customer_email,
          oi.quantity,
          oi.price,
          oi.subtotal,
          -- pro-rate delivery charge: this item's share of the order's delivery fee
          CASE
            WHEN COALESCE(o.delivery_charge, 0) > 0
            THEN ROUND(
              (oi.quantity::DECIMAL / NULLIF(SUM(oi2.quantity) OVER (PARTITION BY o.id), 0))
              * o.delivery_charge, 2
            )
            ELSE 0
          END AS item_delivery_charge
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
        LEFT JOIN order_items oi2 ON oi2.order_id = o.id
        WHERE oi.product_id = $1

        UNION ALL

        -- Refunded returns add stock back; include them so the running balance stays correct
        SELECT
          'return'                                          AS type,
          r.id                                             AS order_id,
          COALESCE(r.return_number, 'RTN-' || r.id::text) AS order_number,
          r.processed_at                                   AS order_date,
          r.status,
          NULL                                             AS delivery_speed,
          0                                               AS delivery_charge,
          u.full_name  AS customer_name,
          u.email      AS customer_email,
          ri.quantity,
          ri.price,
          (ri.quantity * ri.price)::DECIMAL(10,2)          AS subtotal,
          0                                               AS item_delivery_charge
        FROM return_items ri
        JOIN returns r ON ri.return_id = r.id
        LEFT JOIN users u ON r.user_id = u.id
        WHERE ri.product_id = $1
          AND r.status = 'refunded'
          AND r.processed_at IS NOT NULL

        ORDER BY order_date DESC
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
        total_revenue: parseFloat(product.total_revenue) || 0,
        total_cost: parseFloat(product.total_cost) || 0,
        total_profit: (parseFloat(product.total_revenue) || 0) - (parseFloat(product.total_cost) || 0),
        images: product.images,
        is_active: product.is_active,
        created_at: product.created_at,
        transactions: transactionsResult.rows.map(t => ({
          type: t.type,
          order_id: t.order_id,
          order_number: t.order_number,
          order_date: t.order_date,
          status: t.status,
          delivery_speed: t.delivery_speed,
          item_delivery_charge: parseFloat(t.item_delivery_charge) || 0,
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
          type: t.type || 'sale',
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
    const hasHeadingImageField = Object.prototype.hasOwnProperty.call(req.body || {}, 'heading_image_url');
    const normalizedHeadingImage = hasHeadingImageField ? String(heading_image_url || '').trim() : null;
    
    const query = `
      UPDATE homepage_sections 
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          heading_image_url = CASE WHEN $7 THEN NULLIF($3, '') ELSE heading_image_url END,
          sort_order = COALESCE($4, sort_order),
          is_active = COALESCE($5, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;
    
    const result = await db.query(query, [name, description, normalizedHeadingImage, sort_order, is_active, id, hasHeadingImageField]);
    
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

exports.clearAllHomepageSectionHeadingImages = async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE homepage_sections
      SET heading_image_url = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE heading_image_url IS NOT NULL
        AND BTRIM(heading_image_url) <> ''
      RETURNING id
    `);
    res.json({
      success: true,
      clearedCount: result.rowCount || 0,
      message: `Cleared old section images for ${result.rowCount || 0} section(s).`
    });
  } catch (error) {
    console.error('Clear all homepage section heading images error:', error);
    res.status(500).json({ error: 'Failed to clear old section images.' });
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
      logo_size,
      logo_size_mobile,
      homepage_hero_title,
      homepage_hero_subtitle,
      homepage_hero_image_url,
      homepage_hero_section_id,
      about_us_description,
      about_page_title,
      about_intro_title,
      about_mission_vision_title,
      about_us_heading_1,
      about_us_heading_2,
      about_us_heading_3,
      about_us_heading_4,
      about_us_heading_5,
      about_us_paragraph_1,
      about_us_paragraph_2,
      about_us_paragraph_3,
      about_us_paragraph_4,
      about_us_paragraph_5,
      contact_email,
      contact_phone,
      contact_location,
      business_support_email,
      admin_license_blocked,
      admin_license_expires_at,
      fast_delivery_enabled,
      fast_delivery_charge,
      gpay_enabled,
      gpay_payee_name,
      gpay_upi_id,
      gpay_phone_number,
      gpay_bank_name,
      gpay_qr_image_url,
      slider_image_1,
      slider_image_2,
      slider_image_3,
      slider_image_4,
      slider_image_5,
      site_notice_text,
      site_notice_enabled
    } = req.body || {};

    const hasLicenseChange =
      admin_license_blocked !== undefined ||
      admin_license_expires_at !== undefined;

    const hasSuperAdminOnlyCommerceSetting =
      business_support_email !== undefined ||
      gpay_enabled !== undefined ||
      gpay_payee_name !== undefined ||
      gpay_upi_id !== undefined ||
      gpay_phone_number !== undefined ||
      gpay_bank_name !== undefined ||
      gpay_qr_image_url !== undefined ||
      req.body?.cod_available_pincodes !== undefined;

    if (hasLicenseChange && req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can manage admin license settings.' });
    }

    if (hasSuperAdminOnlyCommerceSetting && req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can manage Business Email, GPay, and COD pincode settings.' });
    }

    // Collect all provided settings so this endpoint can be reused
    // for logo and any homepage text headings.
    const updates = [];

    if (logo_url !== undefined) {
      updates.push({ key: 'logo_url', value: logo_url });
    }
    if (logo_size !== undefined) {
      const parsedLogoSize = parseInt(logo_size, 10);
      if (Number.isNaN(parsedLogoSize) || parsedLogoSize < 20 || parsedLogoSize > 80) {
        return res.status(400).json({ error: 'Logo size must be a number between 20 and 80.' });
      }
      updates.push({ key: 'logo_size', value: String(parsedLogoSize) });
    }
    if (logo_size_mobile !== undefined) {
      const parsedMobileSize = parseInt(logo_size_mobile, 10);
      if (Number.isNaN(parsedMobileSize) || parsedMobileSize < 16 || parsedMobileSize > 60) {
        return res.status(400).json({ error: 'Mobile logo size must be a number between 16 and 60.' });
      }
      updates.push({ key: 'logo_size_mobile', value: String(parsedMobileSize) });
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
    if (about_us_description !== undefined) {
      updates.push({ key: 'about_us_description', value: String(about_us_description || '').trim() });
    }
    if (about_page_title !== undefined) {
      updates.push({ key: 'about_page_title', value: String(about_page_title || '').trim() });
    }
    if (about_intro_title !== undefined) {
      updates.push({ key: 'about_intro_title', value: String(about_intro_title || '').trim() });
    }
    if (about_mission_vision_title !== undefined) {
      updates.push({ key: 'about_mission_vision_title', value: String(about_mission_vision_title || '').trim() });
    }
    if (about_us_heading_1 !== undefined) {
      updates.push({ key: 'about_us_heading_1', value: String(about_us_heading_1 || '').trim() });
    }
    if (about_us_heading_2 !== undefined) {
      updates.push({ key: 'about_us_heading_2', value: String(about_us_heading_2 || '').trim() });
    }
    if (about_us_heading_3 !== undefined) {
      updates.push({ key: 'about_us_heading_3', value: String(about_us_heading_3 || '').trim() });
    }
    if (about_us_heading_4 !== undefined) {
      updates.push({ key: 'about_us_heading_4', value: String(about_us_heading_4 || '').trim() });
    }
    if (about_us_heading_5 !== undefined) {
      updates.push({ key: 'about_us_heading_5', value: String(about_us_heading_5 || '').trim() });
    }
    if (about_us_paragraph_1 !== undefined) {
      updates.push({ key: 'about_us_paragraph_1', value: String(about_us_paragraph_1 || '').trim() });
    }
    if (about_us_paragraph_2 !== undefined) {
      updates.push({ key: 'about_us_paragraph_2', value: String(about_us_paragraph_2 || '').trim() });
    }
    if (about_us_paragraph_3 !== undefined) {
      updates.push({ key: 'about_us_paragraph_3', value: String(about_us_paragraph_3 || '').trim() });
    }
    if (about_us_paragraph_4 !== undefined) {
      updates.push({ key: 'about_us_paragraph_4', value: String(about_us_paragraph_4 || '').trim() });
    }
    if (about_us_paragraph_5 !== undefined) {
      updates.push({ key: 'about_us_paragraph_5', value: String(about_us_paragraph_5 || '').trim() });
    }
    if (contact_email !== undefined) {
      const val = String(contact_email || '').trim();
      if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        return res.status(400).json({ error: 'Contact email must be a valid email address.' });
      }
      updates.push({ key: 'contact_email', value: val });
    }
    if (contact_phone !== undefined) {
      updates.push({ key: 'contact_phone', value: String(contact_phone || '').trim() });
    }
    if (contact_location !== undefined) {
      updates.push({ key: 'contact_location', value: String(contact_location || '').trim() });
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

    if (gpay_enabled !== undefined && gpay_enabled !== null) {
      const enabledValue =
        typeof gpay_enabled === 'boolean'
          ? gpay_enabled
          : String(gpay_enabled).toLowerCase() === 'true';
      updates.push({ key: 'gpay_enabled', value: enabledValue ? 'true' : 'false' });
    }

    if (gpay_payee_name !== undefined) {
      const payeeName = String(gpay_payee_name || '').trim();
      updates.push({ key: 'gpay_payee_name', value: payeeName });
    }

    if (gpay_upi_id !== undefined) {
      const upiId = String(gpay_upi_id || '').trim();
      if (upiId && !/^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/i.test(upiId)) {
        return res.status(400).json({ error: 'GPay UPI ID format looks invalid. Example: yourname@oksbi' });
      }
      updates.push({ key: 'gpay_upi_id', value: upiId });
    }

    if (gpay_phone_number !== undefined) {
      const phoneNumber = String(gpay_phone_number || '').trim();
      if (phoneNumber && !/^[0-9+\-\s()]{8,20}$/.test(phoneNumber)) {
        return res.status(400).json({ error: 'GPay phone number format looks invalid.' });
      }
      updates.push({ key: 'gpay_phone_number', value: phoneNumber });
    }

    if (gpay_bank_name !== undefined) {
      const bankName = String(gpay_bank_name || '').trim();
      updates.push({ key: 'gpay_bank_name', value: bankName });
    }

    if (gpay_qr_image_url !== undefined) {
      const qrImageUrl = String(gpay_qr_image_url || '').trim();
      if (qrImageUrl && !/^(https?:\/\/|\/uploads\/)/i.test(qrImageUrl)) {
        return res.status(400).json({ error: 'GPay QR image must be an uploaded image path or a valid http/https URL.' });
      }
      updates.push({ key: 'gpay_qr_image_url', value: qrImageUrl });
    }

    // Homepage hero slider images (1–5)
    for (let i = 1; i <= 5; i++) {
      const sliderVal = req.body[`slider_image_${i}`];
      if (sliderVal !== undefined) {
        const imgUrl = String(sliderVal || '').trim();
        if (imgUrl && !/^(https?:\/\/|\/uploads\/)/i.test(imgUrl)) {
          return res.status(400).json({ error: `slider_image_${i} must be an uploaded image path or a valid http/https URL.` });
        }
        updates.push({ key: `slider_image_${i}`, value: imgUrl });
      }
    }

    // Featured Deals flip cards (1–5): front image, back image, label text, title text
    for (let i = 1; i <= 5; i++) {
      for (const side of ['front', 'back']) {
        const imgVal = req.body[`flip_card_${side}_${i}`];
        if (imgVal !== undefined) {
          const imgUrl = String(imgVal || '').trim();
          if (imgUrl && !/^(https?:\/\/|\/uploads\/)/i.test(imgUrl)) {
            return res.status(400).json({ error: `flip_card_${side}_${i} must be an uploaded image path or a valid URL.` });
          }
          updates.push({ key: `flip_card_${side}_${i}`, value: imgUrl });
        }
      }
      const labelVal = req.body[`flip_card_label_${i}`];
      if (labelVal !== undefined) {
        updates.push({ key: `flip_card_label_${i}`, value: String(labelVal || '').trim().slice(0, 80) });
      }
      const titleVal = req.body[`flip_card_title_${i}`];
      if (titleVal !== undefined) {
        updates.push({ key: `flip_card_title_${i}`, value: String(titleVal || '').trim().slice(0, 100) });
      }
    }

    // Mobile hero background image
    if (req.body.mobile_hero_bg !== undefined) {
      const mbUrl = String(req.body.mobile_hero_bg || '').trim();
      if (mbUrl && !/^(https?:\/\/|\/uploads\/)/i.test(mbUrl)) {
        return res.status(400).json({ error: 'mobile_hero_bg must be an uploaded image path or a valid URL.' });
      }
      updates.push({ key: 'mobile_hero_bg', value: mbUrl });
    }

    // Section banners: section_pc_banners_{id} / section_mobile_banners_{id}
    // Accepts new single-object format {url, shape} OR legacy array-of-URLs format OR 'null'/'null'
    const sectionBannerRe = /^section_(pc|mobile)_banners_(\d+)$/;
    const validBannerShapes = ['full', 'circle', 'rectangle', 'square', 'triangle', 'star'];

    // Site notice / situation reason banner
    if (site_notice_text !== undefined) {
      updates.push({ key: 'site_notice_text', value: String(site_notice_text || '').trim().slice(0, 400) });
    }
    if (site_notice_enabled !== undefined) {
      const enabledVal = typeof site_notice_enabled === 'boolean'
        ? site_notice_enabled
        : String(site_notice_enabled).toLowerCase() === 'true';
      updates.push({ key: 'site_notice_enabled', value: enabledVal ? 'true' : 'false' });
    }
    for (const key of Object.keys(req.body)) {
      if (sectionBannerRe.test(key)) {
        const rawVal = String(req.body[key] || '').trim();
        // Allow explicit clear
        if (!rawVal || rawVal === 'null' || rawVal === '[]' || rawVal === '{}') {
          updates.push({ key, value: null });
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(rawVal);
        } catch (_) {
          return res.status(400).json({ error: `${key} must be valid JSON` });
        }
        if (parsed === null) {
          updates.push({ key, value: null });
          continue;
        }
        // New format: single {url, shape, size} object
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const url = String(parsed.url || '').trim();
          if (url && !/^(https?:\/\/|\/uploads\/)/i.test(url)) {
            return res.status(400).json({ error: `${key}: invalid URL` });
          }
          const shape = parsed.shape || 'full';
          if (!validBannerShapes.includes(shape)) {
            return res.status(400).json({ error: `${key}: invalid shape '${shape}'` });
          }
          const size = parsed.size ? parseInt(parsed.size) : undefined;
          if (size !== undefined && (isNaN(size) || size < 10 || size > 2000)) {
            return res.status(400).json({ error: `${key}: size must be 10-2000 px` });
          }
          const zoom = parsed.zoom ? parseInt(parsed.zoom) : undefined;
          if (zoom !== undefined && (isNaN(zoom) || zoom < 50 || zoom > 250)) {
            return res.status(400).json({ error: `${key}: zoom must be 50-250 %` });
          }
          const isGif = parsed.isGif === true;
          updates.push({ key, value: JSON.stringify({ url, shape, ...(size ? { size } : {}), ...(zoom ? { zoom } : {}), ...(isGif ? { isGif: true } : {}) }) });
          continue;
        }
        // Legacy format: array of URL strings — convert to single {url, shape} object
        if (Array.isArray(parsed)) {
          const url = String(parsed[0] || '').trim();
          if (url && !/^(https?:\/\/|\/uploads\/)/i.test(url)) {
            return res.status(400).json({ error: `${key}: invalid URL in array` });
          }
          updates.push({ key, value: url ? JSON.stringify({ url, shape: 'full' }) : null });
          continue;
        }
        return res.status(400).json({ error: `${key}: unrecognised banner format` });
      }
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

exports.getAdminAccountSettings = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Admin account not found.' });
    }

    if (!(user.role === 'admin' || user.role === 'super_admin')) {
      return res.status(403).json({ error: 'Only admin accounts can access these settings.' });
    }

    return res.json({
      user: {
        id: user.id,
        login_email: user.email,
        full_name: user.full_name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Get admin account settings error:', error);
    return res.status(500).json({ error: 'Failed to fetch admin account settings.' });
  }
};

exports.updateAdminAccountSettings = async (req, res) => {
  try {
    const login_email = normalizeEmail(req.body?.login_email || '');
    const current_password = String(req.body?.current_password || '');
    const new_password = String(req.body?.new_password || '');
    const confirm_password = String(req.body?.confirm_password || '');

    const accountResult = await db.query(
      'SELECT id, email, password, role, full_name, is_approved, is_blocked, profile_photo FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    );
    const account = accountResult.rows[0];

    if (!account) {
      return res.status(404).json({ error: 'Admin account not found.' });
    }

    if (!(account.role === 'admin' || account.role === 'super_admin')) {
      return res.status(403).json({ error: 'Only admin accounts can update these settings.' });
    }

    const wantsEmailChange = !!login_email && login_email !== normalizeEmail(account.email);
    const wantsPasswordChange = !!new_password || !!confirm_password;

    if (!wantsEmailChange && !wantsPasswordChange) {
      return res.status(400).json({ error: 'No account changes provided.' });
    }

    if (!current_password) {
      return res.status(400).json({ error: 'Current password is required to update account settings.' });
    }

    const currentPasswordValid = await User.verifyPassword(current_password, account.password);
    if (!currentPasswordValid) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    if (wantsEmailChange) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login_email)) {
        return res.status(400).json({ error: 'Username must be a valid email address.' });
      }

      const emailTaken = await db.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1',
        [login_email, account.id]
      );
      if (emailTaken.rows.length > 0) {
        return res.status(400).json({ error: 'This username/email is already in use.' });
      }

      await db.query(
        'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [login_email, account.id]
      );
    }

    if (wantsPasswordChange) {
      if (!new_password || !confirm_password) {
        return res.status(400).json({ error: 'New password and confirm password are required.' });
      }

      if (new_password.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }

      if (new_password !== confirm_password) {
        return res.status(400).json({ error: 'New password and confirm password do not match.' });
      }

      const isSame = await User.verifyPassword(new_password, account.password);
      if (isSame) {
        return res.status(400).json({ error: 'New password must be different from current password.' });
      }

      const hashedPassword = await bcrypt.hash(new_password, 10);
      await db.query(
        'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [hashedPassword, account.id]
      );
    }

    const updatedResult = await db.query(
      'SELECT id, email, full_name, role, is_approved, is_blocked, profile_photo FROM users WHERE id = $1 LIMIT 1',
      [account.id]
    );
    const updatedUser = updatedResult.rows[0];

    const token = jwt.sign(
      {
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        is_approved: updatedUser.is_approved,
        is_blocked: updatedUser.is_blocked
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const forceSecureCookie = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const isHttps = !!req.secure || forwardedProto === 'https';

    res.cookie('token', token, {
      httpOnly: true,
      secure: forceSecureCookie ? true : isHttps,
      sameSite: 'lax',
      path: '/'
    });

    return res.json({
      success: true,
      message: 'Admin account settings updated successfully.',
      token,
      user: {
        id: updatedUser.id,
        login_email: updatedUser.email,
        full_name: updatedUser.full_name,
        role: updatedUser.role,
        profile_photo: updatedUser.profile_photo
      }
    });
  } catch (error) {
    console.error('Update admin account settings error:', error);
    return res.status(500).json({ error: 'Failed to update admin account settings.' });
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

// Search customers/wholesale users by email, name, or id (for admin messaging)
exports.searchUsers = async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || '').trim();
    const rawLimit = parseInt(req.query.limit || '10', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 20)) : 10;

    if (!query) {
      return res.json({ users: [] });
    }

    const maybeId = parseInt(query, 10);
    const like = `%${query}%`;

    let result;
    if (Number.isFinite(maybeId)) {
      result = await db.query(
        `
          SELECT id, email, full_name, phone, role
          FROM users
          WHERE role IN ('customer', 'wholesale')
            AND is_blocked = false
            AND (id = $1 OR email ILIKE $2 OR full_name ILIKE $2)
          ORDER BY id ASC
          LIMIT $3
        `,
        [maybeId, like, limit]
      );
    } else {
      result = await db.query(
        `
          SELECT id, email, full_name, phone, role
          FROM users
          WHERE role IN ('customer', 'wholesale')
            AND is_blocked = false
            AND (email ILIKE $1 OR full_name ILIKE $1)
          ORDER BY id ASC
          LIMIT $2
        `,
        [like, limit]
      );
    }

    return res.json({ users: result.rows || [] });
  } catch (error) {
    console.error('Search users error:', error);
    return res.status(500).json({ error: 'Failed to search users.' });
  }
};

exports.getAdminMessageHistory = async (req, res) => {
  try {
    await ensureAdminMessageHistoryTable();

    const rawLimit = parseInt(req.query.limit || '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50;

    const result = await db.query(
      `
        SELECT
          h.id,
          h.admin_user_id,
          h.audience,
          h.identifier_type,
          h.identifier,
          h.subject,
          h.message_body,
          h.channels,
          h.summary,
          h.created_at,
          u.full_name AS admin_name,
          u.email AS admin_email
        FROM admin_message_history h
        LEFT JOIN users u ON u.id = h.admin_user_id
        ORDER BY h.created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return res.json({ history: result.rows || [] });
  } catch (error) {
    console.error('Get admin message history error:', error);
    return res.status(500).json({ error: 'Failed to fetch sent message history.' });
  }
};

// Send message to users (email and/or sms) - all customers / wholesale / all users / single
exports.sendAdminMessage = async (req, res) => {
  try {
    const body = req.body || {};
    const audience = String(body.audience || 'all').trim().toLowerCase();
    const identifierType = String(body.identifierType || 'email').trim().toLowerCase();
    const identifier = String(body.identifier || '').trim();
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();
    const channels = body.channels || {};
    const sendEmail = channels.email !== false; // default true
    const sendSms = !!channels.sms;
    const sendWhatsapp = !!channels.whatsapp;

    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    if (!['all', 'customers', 'wholesale', 'single'].includes(audience)) {
      return res.status(400).json({ error: 'Invalid audience.' });
    }

    if (audience === 'single' && !['email', 'id'].includes(identifierType)) {
      return res.status(400).json({ error: 'Invalid identifier type.' });
    }

    const recipients = await getMessageRecipients({ audience, identifierType, identifier });
    if (!recipients || recipients.length === 0) {
      return res.status(404).json({ error: 'No matching users found.' });
    }

    // Filter out blocked users
    const activeRecipients = recipients.filter(r => !r.is_blocked);
    if (!activeRecipients.length) {
      return res.status(400).json({ error: 'All matched users are blocked.' });
    }

    let transporter = null;
    let fromEmail = '';
    const resendAvailable = canUseResendForAdmin();
    let firstEmailError = '';
    if (sendEmail) {
      try {
        transporter = createSmtpTransporterOrThrow();
        fromEmail = getSmtpConfig().fromEmail;
      } catch (e) {
        // Only fail if email is the only requested channel and Resend is unavailable
        if (!sendSms && !sendWhatsapp && !resendAvailable) {
          return res.status(503).json({ error: e.message || 'Email is not configured.' });
        }
      }
    }

    if (sendSms && (!twilioClient || !TWILIO_FROM_NUMBER)) {
      if (!sendEmail && !sendWhatsapp) {
        return res.status(503).json({ error: 'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.' });
      }
    }

    if (sendWhatsapp && (!twilioClient || !TWILIO_WHATSAPP_FROM_NUMBER)) {
      if (!sendEmail && !sendSms) {
        return res.status(503).json({ error: 'WhatsApp is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM_NUMBER.' });
      }
    }

    const summary = {
      totalRecipients: activeRecipients.length,
      email: { attempted: 0, sent: 0, skippedNoEmail: 0, failed: 0 },
      sms: { attempted: 0, sent: 0, skippedNoPhone: 0, failed: 0 },
      whatsapp: { attempted: 0, sent: 0, skippedNoPhone: 0, invalidPhone: 0, failed: 0 }
    };

    if (sendEmail) {
      const emailTargets = activeRecipients
        .map((user) => normalizeEmail(user.email))
        .filter((value) => !!value);
      summary.email.skippedNoEmail = activeRecipients.length - emailTargets.length;

      if (!transporter || !fromEmail) {
        if (resendAvailable && emailTargets.length > 0) {
          const chunks = chunkArray(emailTargets, EMAIL_BCC_CHUNK_SIZE);
          for (const chunk of chunks) {
            summary.email.attempted += chunk.length;
            try {
              await withTimeout(
                sendViaResend({ toList: chunk, subject, message }),
                EMAIL_SEND_TIMEOUT_MS,
                'Resend email timed out.'
              );
              summary.email.sent += chunk.length;
            } catch (err) {
              summary.email.failed += chunk.length;
              if (!firstEmailError) {
                firstEmailError = String(err?.message || 'Resend email failed.');
              }
            }
          }
        } else {
          summary.email.failed += emailTargets.length;
          if (!firstEmailError) {
            firstEmailError = 'Email sender is not configured.';
          }
        }
      } else if (emailTargets.length > 0) {
        if (audience === 'single' || emailTargets.length <= 2) {
          for (const toEmail of emailTargets) {
            summary.email.attempted++;
            try {
              await withTimeout(
                transporter.sendMail({
                  from: fromEmail,
                  to: toEmail,
                  subject: subject || 'Message from Mount Made',
                  text: message
                }),
                EMAIL_SEND_TIMEOUT_MS,
                'Email sending timed out.'
              );
              summary.email.sent++;
            } catch (err) {
              // fallback to resend for this recipient if available
              if (resendAvailable) {
                try {
                  await withTimeout(
                    sendViaResend({ toList: [toEmail], subject, message }),
                    EMAIL_SEND_TIMEOUT_MS,
                    'Resend email timed out.'
                  );
                  summary.email.sent++;
                  continue;
                } catch (fallbackErr) {
                  summary.email.failed++;
                  if (!firstEmailError) {
                    firstEmailError = String(fallbackErr?.message || err?.message || 'Email sending failed.');
                  }
                }
              } else {
                summary.email.failed++;
                if (!firstEmailError) {
                  firstEmailError = String(err?.message || 'Email sending failed.');
                }
              }
            }
          }
        } else {
          const chunks = chunkArray(emailTargets, EMAIL_BCC_CHUNK_SIZE);
          for (const chunk of chunks) {
            summary.email.attempted += chunk.length;
            try {
              await withTimeout(
                transporter.sendMail({
                  from: fromEmail,
                  to: fromEmail,
                  bcc: chunk,
                  subject: subject || 'Message from Mount Made',
                  text: message
                }),
                EMAIL_SEND_TIMEOUT_MS,
                'Bulk email sending timed out.'
              );
              summary.email.sent += chunk.length;
            } catch (err) {
              if (resendAvailable) {
                try {
                  await withTimeout(
                    sendViaResend({ toList: chunk, subject, message }),
                    EMAIL_SEND_TIMEOUT_MS,
                    'Resend bulk email timed out.'
                  );
                  summary.email.sent += chunk.length;
                  continue;
                } catch (fallbackErr) {
                  summary.email.failed += chunk.length;
                  if (!firstEmailError) {
                    firstEmailError = String(fallbackErr?.message || err?.message || 'Bulk email failed.');
                  }
                }
              } else {
                summary.email.failed += chunk.length;
                if (!firstEmailError) {
                  firstEmailError = String(err?.message || 'Bulk email failed.');
                }
              }
            }
          }
        }
      }
    }

    if (sendSms) {
      const smsTargets = activeRecipients
        .map((user) => normalizePhone(user.phone))
        .filter((value) => !!value);
      summary.sms.skippedNoPhone = activeRecipients.length - smsTargets.length;

      if (!twilioClient || !TWILIO_FROM_NUMBER) {
        summary.sms.failed += smsTargets.length;
      } else if (smsTargets.length > 0) {
        const smsBody = subject ? `${subject}\n${message}` : message;
        await runWithConcurrency(smsTargets, SMS_CONCURRENCY, async (toPhone) => {
          summary.sms.attempted++;
          try {
            await withTimeout(
              twilioClient.messages.create({
                from: TWILIO_FROM_NUMBER,
                to: toPhone,
                body: smsBody
              }),
              SMS_SEND_TIMEOUT_MS,
              'SMS sending timed out.'
            );
            summary.sms.sent++;
          } catch (_) {
            summary.sms.failed++;
          }
        });
      }
    }

    if (sendWhatsapp) {
      const whatsappTargets = activeRecipients
        .map((user) => normalizePhone(user.phone))
        .filter((value) => !!value);
      summary.whatsapp.skippedNoPhone = activeRecipients.length - whatsappTargets.length;

      if (!twilioClient || !TWILIO_WHATSAPP_FROM_NUMBER) {
        summary.whatsapp.failed += whatsappTargets.length;
      } else if (whatsappTargets.length > 0) {
        const whatsappBody = subject ? `${subject}\n${message}` : message;
        const whatsappFrom = `whatsapp:${TWILIO_WHATSAPP_FROM_NUMBER.replace(/^whatsapp:/i, '')}`;
        await runWithConcurrency(whatsappTargets, WHATSAPP_CONCURRENCY, async (rawPhone) => {
          const toWhatsapp = toWhatsappAddress(rawPhone);
          if (!toWhatsapp) {
            summary.whatsapp.invalidPhone++;
            return;
          }

          summary.whatsapp.attempted++;
          try {
            await withTimeout(
              twilioClient.messages.create({
                from: whatsappFrom,
                to: toWhatsapp,
                body: whatsappBody
              }),
              WHATSAPP_SEND_TIMEOUT_MS,
              'WhatsApp sending timed out.'
            );
            summary.whatsapp.sent++;
          } catch (_) {
            summary.whatsapp.failed++;
          }
        });
      }
    }

    if (transporter && typeof transporter.close === 'function') {
      try {
        transporter.close();
      } catch (_) {
        // ignore close errors
      }
    }

    if (sendEmail && summary.email.attempted > 0 && summary.email.sent === 0 && !sendSms && !sendWhatsapp) {
      return res.status(502).json({
        error: firstEmailError || 'Failed to send emails. Check SMTP/Resend configuration and sender domain verification.'
      });
    }

    try {
      await ensureAdminMessageHistoryTable();
      await db.query(
        `
          INSERT INTO admin_message_history
            (admin_user_id, audience, identifier_type, identifier, subject, message_body, channels, summary)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
        `,
        [
          req.user?.id || null,
          audience,
          identifierType || null,
          identifier || null,
          subject || null,
          message,
          JSON.stringify({ email: !!sendEmail, sms: !!sendSms, whatsapp: !!sendWhatsapp }),
          JSON.stringify(summary)
        ]
      );
    } catch (historyErr) {
      console.error('Save admin message history error:', historyErr);
    }

    return res.json({
      message: 'Message send attempt completed.',
      summary
    });
  } catch (error) {
    console.error('Send admin message error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send message.' });
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

// ══════════════════════════════════════════════════════════════════════════
// RETURNS MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════

exports.getAllReturns = async (req, res) => {
  try {
    const statusFilter = (req.query.status || '').trim();
    const where = [];
    const params = [];

    if (statusFilter) {
      params.push(statusFilter);
      where.push(`r.status = $${params.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT r.*,
              u.full_name as customer_name, u.email as customer_email, u.role as customer_role,
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
       JOIN users u ON u.id = r.user_id
       JOIN orders o ON o.id = r.order_id
       LEFT JOIN return_items ri ON ri.return_id = r.id
       LEFT JOIN products p ON p.id = ri.product_id
       ${whereClause}
       GROUP BY r.id, u.full_name, u.email, u.role, o.order_number, o.total_amount
       ORDER BY r.created_at DESC`
      , params
    );

    res.json({ returns: result.rows });
  } catch (error) {
    console.error('Get all returns error:', error);
    res.status(500).json({ error: 'Failed to fetch returns.' });
  }
};

exports.updateReturnStatus = async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const { status, admin_notes } = req.body;
    const validStatuses = ['requested', 'approved', 'received', 'refunded', 'rejected'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const existing = await client.query('SELECT * FROM returns WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Return not found.' });

    await client.query('BEGIN');

    const updateFields = ['status = $1', 'updated_at = NOW()'];
    const updateParams = [status];

    if (admin_notes !== undefined) {
      updateParams.push(admin_notes.substring(0, 2000));
      updateFields.push(`admin_notes = $${updateParams.length}`);
    }

    if (status === 'refunded' || status === 'rejected') {
      updateFields.push('processed_at = NOW()');
    }

    updateParams.push(id);
    await client.query(
      `UPDATE returns SET ${updateFields.join(', ')} WHERE id = $${updateParams.length}`,
      updateParams
    );

    // If received — restock product quantities, then auto-advance to refunded
    if (status === 'received') {
      const returnItems = await client.query(
        'SELECT product_id, quantity FROM return_items WHERE return_id = $1',
        [id]
      );
      for (const ri of returnItems.rows) {
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
          [ri.quantity, ri.product_id]
        );
      }
      // Auto-advance to refunded so customer sees refund confirmation immediately
      await client.query(
        `UPDATE returns SET status = 'refunded', processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }

    await client.query('COMMIT');

    const finalStatus = status === 'received' ? 'refunded' : status;

    const updated = await client.query(
      `SELECT r.*, u.full_name as customer_name, o.order_number
       FROM returns r JOIN users u ON u.id = r.user_id JOIN orders o ON o.id = r.order_id
       WHERE r.id = $1`, [id]
    );

    res.json({ message: `Return status updated to "${finalStatus}".`, return: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Update return status error:', error);
    res.status(500).json({ error: 'Failed to update return.' });
  } finally {
    client.release();
  }
};

exports.getReturnStats = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'requested') as pending_returns,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_returns,
        COUNT(*) FILTER (WHERE status = 'received') as received_returns,
        COUNT(*) FILTER (WHERE status = 'refunded') as refunded_returns,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_returns,
        COUNT(*) as total_returns,
        COALESCE(SUM(refund_amount) FILTER (WHERE status = 'refunded'), 0) as total_refunded
      FROM returns
    `);
    res.json({ stats: result.rows[0] });
  } catch (error) {
    console.error('Get return stats error:', error);
    res.status(500).json({ error: 'Failed to fetch return stats.' });
  }
};
