const db = require('../config/database');
const bcrypt = require('bcryptjs');

class User {
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

  static async findByEmail(email) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const query = 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)';
    const result = await db.query(query, [normalizedEmail]);
    return result.rows[0];
  }

  static async findById(id) {
    const queryWithProfilePhoto = 'SELECT id, email, full_name, phone, role, business_name, tax_id, is_approved, is_blocked, profile_photo, created_at FROM users WHERE id = $1';
    try {
      const result = await db.query(queryWithProfilePhoto, [id]);
      return result.rows[0];
    } catch (error) {
      // Backward-compatibility for databases that do not yet have users.profile_photo
      if (error?.code === '42703') {
        const fallbackQuery = 'SELECT id, email, full_name, phone, role, business_name, tax_id, is_approved, is_blocked, created_at FROM users WHERE id = $1';
        const result = await db.query(fallbackQuery, [id]);
        return result.rows[0];
      }
      throw error;
    }
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
