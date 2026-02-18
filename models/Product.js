const db = require('../config/database');

class Product {
  static async ensureSchemaCompatibility() {
    if (this._schemaReady) return;
    try {
      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          category_id INTEGER,
          homepage_section_id INTEGER,
          price DECIMAL(10, 2) NOT NULL,
          wholesale_price DECIMAL(10, 2),
          stock_quantity INTEGER DEFAULT 0,
          min_wholesale_qty INTEGER DEFAULT 10,
          image_url VARCHAR(500),
          images JSONB DEFAULT '[]'::jsonb,
          is_active BOOLEAN DEFAULT true,
          weight DECIMAL(10, 2),
          unit VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) UNIQUE NOT NULL,
          description TEXT,
          image_url VARCHAR(500),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS homepage_sections (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) UNIQUE NOT NULL,
          description TEXT,
          sort_order INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS homepage_section_id INTEGER');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INTEGER DEFAULT 0');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS min_wholesale_qty INTEGER DEFAULT 10');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true');
      await db.pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb");
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS weight NUMERIC');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(50)');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

      await db.pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='products' AND column_name='stock'
          ) THEN
            UPDATE products
            SET stock_quantity = COALESCE(stock_quantity, stock, 0)
            WHERE stock_quantity IS NULL OR stock_quantity = 0;
          END IF;
        END $$;
      `);
    } catch (err) {
      console.warn('ensureSchemaCompatibility warning:', err.message || err);
    }
    this._schemaReady = true;
  }

  static async ensureDiscountColumns() {
    await this.ensureSchemaCompatibility();
    if (this._discountReady) return;
    try {
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_price NUMERIC');
      await db.pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_percentage NUMERIC');
    } catch (err) {
      console.warn('ensureDiscountColumns warning:', err.message || err);
    }
    this._discountReady = true;
  }

  static async create(productData) {
    await this.ensureDiscountColumns();
    const { 
      name, 
      description, 
      category_id,
      homepage_section_id,
      price, 
      wholesale_price, 
      discount_price,
      stock_quantity, 
      min_wholesale_qty,
      image_url, 
      images,
      is_active,
      weight,
      unit
    } = productData;

    const query = `
      INSERT INTO products (
        name, description, category_id, homepage_section_id, price, wholesale_price, discount_price,
        stock_quantity, min_wholesale_qty, image_url, images, is_active, weight, unit
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;

    const values = [
      name, 
      description, 
      category_id,
      homepage_section_id || null,
      price, 
      wholesale_price, 
      discount_price,
      stock_quantity,
      min_wholesale_qty || 10,
      image_url, 
      JSON.stringify(images || []),
      is_active !== undefined && is_active !== null ? !!is_active : true,
      weight,
      unit
    ];

    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async findAll(filters = {}) {
    await this.ensureDiscountColumns();

    let query = `
      SELECT p.*, c.name as category_name 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE COALESCE(p.is_active, true) = true
    `;

    const values = [];
    let paramCount = 1;

    if (filters.category_id) {
      query += ` AND p.category_id = $${paramCount}`;
      values.push(filters.category_id);
      paramCount++;
    }

    if (filters.search) {
      query += ` AND (p.name ILIKE $${paramCount} OR p.description ILIKE $${paramCount})`;
      values.push(`%${filters.search}%`);
      paramCount++;
    }

    if (filters.min_price !== undefined && filters.min_price !== null && !isNaN(filters.min_price)) {
      query += ` AND p.price >= $${paramCount}`;
      values.push(filters.min_price);
      paramCount++;
    }

    if (filters.max_price !== undefined && filters.max_price !== null && !isNaN(filters.max_price)) {
      query += ` AND p.price <= $${paramCount}`;
      values.push(filters.max_price);
      paramCount++;
    }

    query += ' ORDER BY p.created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramCount}`;
      values.push(filters.limit);
      paramCount++;
    }

    if (filters.offset) {
      query += ` OFFSET $${paramCount}`;
      values.push(filters.offset);
    }

    try {
      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      const code = error?.code;
      if (code === '42703' || code === '42P01') {
        const fallbackResult = await db.query('SELECT * FROM products ORDER BY id DESC');
        return fallbackResult.rows;
      }
      throw error;
    }
  }

  static async findById(id) {
    await this.ensureDiscountColumns();
    const query = `
      SELECT p.*, c.name as category_name 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `;
    try {
      const result = await db.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      const code = error?.code;
      if (code === '42703' || code === '42P01') {
        const fallbackResult = await db.query('SELECT * FROM products WHERE id = $1', [id]);
        return fallbackResult.rows[0];
      }
      throw error;
    }
  }

  static async update(id, productData) {
    await this.ensureDiscountColumns();
    const { 
      name, 
      description, 
      category_id,
      homepage_section_id,
      price, 
      wholesale_price, 
      discount_price,
      stock_quantity,
      min_wholesale_qty,
      image_url, 
      images,
      is_active,
      weight,
      unit
    } = productData;

    const query = `
      UPDATE products
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          category_id = COALESCE($3, category_id),
          homepage_section_id = $4,
          price = COALESCE($5, price),
          wholesale_price = COALESCE($6, wholesale_price),
          discount_price = COALESCE($7, discount_price),
          stock_quantity = COALESCE($8, stock_quantity),
          min_wholesale_qty = COALESCE($9, min_wholesale_qty),
          image_url = COALESCE($10, image_url),
          images = COALESCE($11, images),
          is_active = COALESCE($12, is_active),
          weight = COALESCE($13, weight),
          unit = COALESCE($14, unit),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $15
      RETURNING *
    `;

    const values = [
      name, 
      description, 
      category_id,
      homepage_section_id !== undefined ? homepage_section_id : null,
      price, 
      wholesale_price, 
      discount_price,
      stock_quantity,
      min_wholesale_qty,
      image_url, 
      images !== undefined ? JSON.stringify(images || []) : null,
      is_active,
      weight,
      unit,
      id
    ];

    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async delete(id) {
    const query = 'UPDATE products SET is_active = false WHERE id = $1 RETURNING *';
    const result = await db.query(query, [id]);
    return result.rows[0];
  }

  static async updateStock(id, quantity) {
    const query = `
      UPDATE products 
      SET stock_quantity = stock_quantity + $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *
    `;
    const result = await db.query(query, [quantity, id]);
    return result.rows[0];
  }

  static async getAllCategories() {
    await this.ensureSchemaCompatibility();
    const query = 'SELECT * FROM categories ORDER BY name';
    const result = await db.query(query);
    return result.rows;
  }

  static async getCategoryById(id) {
    await this.ensureSchemaCompatibility();
    const query = 'SELECT * FROM categories WHERE id = $1';
    const result = await db.query(query, [id]);
    return result.rows[0];
  }

  static async createCategory(name, description, image_url) {
    await this.ensureSchemaCompatibility();
    const query = `
      INSERT INTO categories (name, description, image_url)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const result = await db.query(query, [name, description, image_url]);
    return result.rows[0];
  }
}

module.exports = Product;
