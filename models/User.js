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
    
    const is_approved = role === 'admin' || role === 'customer';
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

  static async findByEmail(email) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await db.query(query, [normalizedEmail]);
    return result.rows[0];
  }

  static async findById(id) {
    const query = 'SELECT id, email, full_name, phone, role, business_name, tax_id, is_approved, is_blocked, created_at FROM users WHERE id = $1';
    const result = await db.query(query, [id]);
    return result.rows[0];
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

  static async getAllUsers() {
    const query = `
      SELECT id, email, full_name, phone, role, business_name, is_approved, is_blocked, created_at 
      FROM users 
      ORDER BY created_at DESC
    `;
    const result = await db.query(query);
    return result.rows;
  }

  static async updateProfile(userId, updates) {
    const { full_name, phone } = updates;
    const query = `
      UPDATE users 
      SET full_name = $1, phone = $2, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $3 
      RETURNING id, email, full_name, phone, role, created_at
    `;
    const result = await db.query(query, [full_name, phone, userId]);
    return result.rows[0];
  }
}

module.exports = User;
