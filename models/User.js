const db = require('../config/database');
const bcrypt = require('bcryptjs');

class User {
  static async ensureUser(params) {
    const {
      email,
      password,
      full_name,
      phone,
      role,
      business_name = null,
      tax_id = null,
      is_approved = true,
      is_blocked = false
    } = params || {};

    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      throw new Error('Email is required');
    }
    if (!password) {
      throw new Error('Password is required');
    }
    if (!full_name) {
      throw new Error('Full name is required');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO users (email, password, full_name, phone, role, business_name, tax_id, is_approved, is_blocked)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (email) DO UPDATE SET
        password = EXCLUDED.password,
        full_name = EXCLUDED.full_name,
        phone = EXCLUDED.phone,
        role = EXCLUDED.role,
        business_name = EXCLUDED.business_name,
        tax_id = EXCLUDED.tax_id,
        is_approved = EXCLUDED.is_approved,
        is_blocked = EXCLUDED.is_blocked,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, email, full_name, phone, role, business_name, tax_id, is_approved, is_blocked, created_at;
    `;

    const values = [
      normalizedEmail,
      hashedPassword,
      full_name,
      phone || null,
      role || 'customer',
      business_name,
      tax_id,
      !!is_approved,
      !!is_blocked
    ];

    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async create(userData) {
    const { email, password, full_name, phone, role, business_name, tax_id } = userData;
    const normalizedEmail = (email || '').trim().toLowerCase();
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const query = `
      INSERT INTO users (email, password, full_name, phone, role, business_name, tax_id, is_approved)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, email, full_name, phone, role, business_name, tax_id, is_approved, created_at
    `;
    
    const is_approved = role === 'admin' || role === 'super_admin' || role === 'customer';
    const values = [normalizedEmail, hashedPassword, full_name, phone, role, business_name, tax_id, is_approved];
    
    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async ensureAdmin(email, password) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO users (email, password, full_name, phone, role, business_name, tax_id, is_approved, is_blocked)
      VALUES ($1, $2, 'Admin User', '1234567890', 'admin', NULL, NULL, true, false)
      ON CONFLICT (email) DO UPDATE SET
        password = EXCLUDED.password,
        role = 'admin',
        is_approved = true,
        is_blocked = false,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, email, full_name, phone, role, business_name, tax_id, is_approved, is_blocked, created_at;
    `;

    const values = [normalizedEmail, hashedPassword];
    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async ensureSuperAdmin(email, password) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO users (email, password, full_name, phone, role, business_name, tax_id, is_approved, is_blocked)
      VALUES ($1, $2, 'Super Admin', '1234567890', 'super_admin', NULL, NULL, true, false)
      ON CONFLICT (email) DO UPDATE SET
        password = EXCLUDED.password,
        role = 'super_admin',
        is_approved = true,
        is_blocked = false,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, email, full_name, phone, role, business_name, tax_id, is_approved, is_blocked, created_at;
    `;

    const values = [normalizedEmail, hashedPassword];
    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async ensureTestCustomer(email, password) {
    return this.ensureUser({
      email,
      password,
      full_name: 'Test Customer',
      phone: '9999999999',
      role: 'customer',
      is_approved: true,
      is_blocked: false
    });
  }

  static async ensureTestWholesale(email, password) {
    return this.ensureUser({
      email,
      password,
      full_name: 'Test Wholesale',
      phone: '9999999999',
      role: 'wholesale',
      business_name: 'Test Wholesale Business',
      tax_id: 'TEST-TAX-0001',
      is_approved: true,
      is_blocked: false
    });
  }

  static async findByEmail(email) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const query = 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)';
    const result = await db.query(query, [normalizedEmail]);
    return result.rows[0];
  }

  static async findByPhone(phone) {
    const normalized = String(phone || '').trim();
    const digitsOnly = normalized.replace(/\D/g, '');
    const query = `
      SELECT *
      FROM users
      WHERE phone = $1
         OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
      ORDER BY id ASC
      LIMIT 1
    `;
    const result = await db.query(query, [normalized, digitsOnly]);
    return result.rows[0];
  }

  static async findById(id) {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await db.query(query, [id]);
    const user = result.rows[0];
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      role: user.role,
      business_name: user.business_name,
      tax_id: user.tax_id,
      is_approved: user.is_approved,
      is_blocked: user.is_blocked,
      profile_photo: user.profile_photo,
      created_at: user.created_at
    };
  }

  static async verifyPassword(plainPassword, hashedPassword) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }

  static async updateApprovalStatus(userId, isApproved) {
    const query = 'UPDATE users SET is_approved = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *';
    const result = await db.query(query, [isApproved, userId]);
    return result.rows[0];
  }

  static async getAllWholesaleUsers() {
    const query = `
      SELECT id, email, full_name, phone, business_name, tax_id, is_approved, is_blocked, created_at 
      FROM users 
      WHERE role = 'wholesale' 
      ORDER BY created_at DESC
    `;
    const result = await db.query(query);
    return result.rows;
  }

  static async getAllUsers(options = {}) {
    const { includeSuperAdmin = false } = options;

    const query = includeSuperAdmin
      ? `
        SELECT id, email, full_name, phone, role, business_name, is_approved, is_blocked, created_at 
        FROM users 
        ORDER BY created_at DESC
      `
      : `
        SELECT id, email, full_name, phone, role, business_name, is_approved, is_blocked, created_at 
        FROM users 
        WHERE role <> 'super_admin'
        ORDER BY created_at DESC
      `;

    const result = await db.query(query);
    return result.rows;
  }

  static async updateProfile(userId, updates) {
    const { full_name, phone, profile_photo } = updates;
    
    // Build dynamic query based on what's being updated
    let query, values;
    
    if (profile_photo !== undefined) {
      query = `
        UPDATE users 
        SET full_name = $1, phone = $2, profile_photo = $3, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $4 
        RETURNING id, email, full_name, phone, role, profile_photo, created_at
      `;
      values = [full_name, phone, profile_photo, userId];
    } else {
      query = `
        UPDATE users 
        SET full_name = $1, phone = $2, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $3 
        RETURNING id, email, full_name, phone, role, profile_photo, created_at
      `;
      values = [full_name, phone, userId];
    }
    
    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      if (error?.code === '42703') {
        const fallbackQuery = `
          UPDATE users 
          SET full_name = $1, phone = $2, updated_at = CURRENT_TIMESTAMP 
          WHERE id = $3 
          RETURNING id, email, full_name, phone, role, created_at
        `;
        const fallbackValues = [full_name, phone, userId];
        const fallbackResult = await db.query(fallbackQuery, fallbackValues);
        return fallbackResult.rows[0];
      }
      throw error;
    }
  }
}

module.exports = User;
