const { Pool } = require('pg');
require('dotenv').config();

// Validate that DB_PASSWORD is set if PostgreSQL requires authentication
if (!process.env.DB_PASSWORD && process.env.NODE_ENV !== 'development-no-auth') {
  console.warn('⚠️  WARNING: DB_PASSWORD is not set in .env file');
  console.warn('If your PostgreSQL server requires a password, the connection will fail.');
  console.warn('Update your .env file with: DB_PASSWORD=your_postgresql_password');
}

const dbName = process.env.DB_NAME || 'mountain_made';

// Create pool config for the target database
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  database: dbName,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// Add password if provided
if (process.env.DB_PASSWORD) {
  poolConfig.password = process.env.DB_PASSWORD;
}

// Add SSL for production (Neon, Supabase, etc.)
if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

// Create a temporary pool config for the postgres database (to create the target database if it doesn't exist)
const adminPoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  database: 'postgres',
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

if (process.env.DB_PASSWORD) {
  adminPoolConfig.password = process.env.DB_PASSWORD;
}

// Add SSL for production
if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') {
  adminPoolConfig.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log('✓ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

// Create database if it doesn't exist
const ensureDatabaseExists = async () => {
  // Skip database creation on Vercel/production (Neon, Supabase, etc.)
  // These services pre-create the database
  if (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') {
    console.log('✓ Using existing cloud database');
    return;
  }
  
  const adminPool = new Pool(adminPoolConfig);
  const client = await adminPool.connect();
  try {
    // Check if database exists
    const result = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    
    if (result.rows.length === 0) {
      console.log(`Creating database: ${dbName}`);
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`✓ Database created: ${dbName}`);
    } else {
      console.log(`✓ Database already exists: ${dbName}`);
    }
  } finally {
    client.release();
    await adminPool.end();
  }
};

// Database initialization and schema creation
const initializeDatabase = async () => {
  // First ensure the database exists
  await ensureDatabaseExists();
  
  const client = await pool.connect();
  try {
    console.log('Initializing database schema...');

    // Create Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        role VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('customer', 'wholesale', 'admin', 'super_admin')),
        business_name VARCHAR(255),
        tax_id VARCHAR(50),
        is_approved BOOLEAN DEFAULT false,
        is_blocked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure role constraint allows super_admin (for existing DBs created before this change)
    await client.query(`
      DO $$
      DECLARE
        constraint_to_drop TEXT;
      BEGIN
        SELECT c.conname INTO constraint_to_drop
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'users'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%role%'
          AND pg_get_constraintdef(c.oid) ILIKE '%IN%'
          AND pg_get_constraintdef(c.oid) ILIKE '%admin%'
        LIMIT 1;

        IF constraint_to_drop IS NOT NULL THEN
          EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT IF EXISTS %I', constraint_to_drop);
        END IF;

        BEGIN
          EXECUTE 'ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN (''customer'',''wholesale'',''admin'',''super_admin''))';
        EXCEPTION WHEN duplicate_object THEN
          -- constraint already exists
        END;
      END $$;
    `);

    // Add is_blocked column if it doesn't exist (for existing databases)
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='users' AND column_name='is_approved') THEN
          ALTER TABLE users ADD COLUMN is_approved BOOLEAN DEFAULT false;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='users' AND column_name='is_blocked') THEN
          ALTER TABLE users ADD COLUMN is_blocked BOOLEAN DEFAULT false;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='users' AND column_name='updated_at') THEN
          ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='users' AND column_name='business_name') THEN
          ALTER TABLE users ADD COLUMN business_name VARCHAR(255);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='users' AND column_name='tax_id') THEN
          ALTER TABLE users ADD COLUMN tax_id VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='users' AND column_name='profile_photo') THEN
          ALTER TABLE users ADD COLUMN profile_photo VARCHAR(500);
        END IF;
      END $$;
    `);

    // Create Categories table
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        image_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create Homepage Sections table for custom featured sections
    await client.query(`
      CREATE TABLE IF NOT EXISTS homepage_sections (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create Site Settings table for logo and other site customizations
    await client.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        id SERIAL PRIMARY KEY,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Legacy compatibility: old site_settings schema used key/value columns
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'site_settings' AND column_name = 'key'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'site_settings' AND column_name = 'setting_key'
        ) THEN
          ALTER TABLE site_settings RENAME COLUMN key TO setting_key;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'site_settings' AND column_name = 'value'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'site_settings' AND column_name = 'setting_value'
        ) THEN
          ALTER TABLE site_settings RENAME COLUMN value TO setting_value;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'site_settings' AND column_name = 'updated_at'
        ) THEN
          ALTER TABLE site_settings ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE site_settings ADD CONSTRAINT site_settings_setting_key_unique UNIQUE (setting_key);
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END;
      END $$;
    `);

    // Create Products table
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        homepage_section_id INTEGER REFERENCES homepage_sections(id) ON DELETE SET NULL,
        price DECIMAL(10, 2) NOT NULL,
        wholesale_price DECIMAL(10, 2),
        stock_quantity INTEGER DEFAULT 0,
        min_wholesale_qty INTEGER DEFAULT 10,
        image_url VARCHAR(500),
        images JSONB DEFAULT '[]',
        is_active BOOLEAN DEFAULT true,
        weight DECIMAL(10, 2),
        unit VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add homepage_section_id column if it doesn't exist (for existing databases)
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='category_id') THEN
          ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='homepage_section_id') THEN
          ALTER TABLE products ADD COLUMN homepage_section_id INTEGER REFERENCES homepage_sections(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='stock_quantity') THEN
          ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='min_wholesale_qty') THEN
          ALTER TABLE products ADD COLUMN min_wholesale_qty INTEGER DEFAULT 10;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='wholesale_price') THEN
          ALTER TABLE products ADD COLUMN wholesale_price DECIMAL(10, 2);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='is_active') THEN
          ALTER TABLE products ADD COLUMN is_active BOOLEAN DEFAULT true;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='images') THEN
          ALTER TABLE products ADD COLUMN images JSONB DEFAULT '[]';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='weight') THEN
          ALTER TABLE products ADD COLUMN weight DECIMAL(10, 2);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='unit') THEN
          ALTER TABLE products ADD COLUMN unit VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='products' AND column_name='updated_at') THEN
          ALTER TABLE products ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;

        -- Legacy compatibility: old schema used "stock" instead of "stock_quantity"
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='products' AND column_name='stock') THEN
          UPDATE products
          SET stock_quantity = COALESCE(stock_quantity, stock, 0)
          WHERE stock_quantity IS NULL OR stock_quantity = 0;
        END IF;
      END $$;
    `);

    // Create Cart table
    await client.query(`
      CREATE TABLE IF NOT EXISTS cart (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, product_id)
      );
    `);

    // Create Orders table
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        order_number VARCHAR(50) UNIQUE NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
        shipping_address JSONB NOT NULL,
        payment_method VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add delivery columns to orders table for shipping options (if they don't already exist)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'order_number'
        ) THEN
          ALTER TABLE orders ADD COLUMN order_number VARCHAR(50);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'shipping_address'
        ) THEN
          ALTER TABLE orders ADD COLUMN shipping_address JSONB DEFAULT '{}'::jsonb;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'payment_method'
        ) THEN
          ALTER TABLE orders ADD COLUMN payment_method VARCHAR(50);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'notes'
        ) THEN
          ALTER TABLE orders ADD COLUMN notes TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'delivery_speed'
        ) THEN
          ALTER TABLE orders ADD COLUMN delivery_speed VARCHAR(50);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'delivery_charge'
        ) THEN
          ALTER TABLE orders ADD COLUMN delivery_charge DECIMAL(10, 2) DEFAULT 0;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'updated_at'
        ) THEN
          ALTER TABLE orders ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE orders ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END;
      END $$;
    `);

    // Create Order Items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        quantity INTEGER NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        subtotal DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'order_items' AND column_name = 'product_name'
        ) THEN
          ALTER TABLE order_items ADD COLUMN product_name VARCHAR(255);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'order_items' AND column_name = 'subtotal'
        ) THEN
          ALTER TABLE order_items ADD COLUMN subtotal DECIMAL(10, 2);
        END IF;
      END $$;
    `);

    // Create Addresses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS addresses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        label VARCHAR(100) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        address_line1 VARCHAR(255) NOT NULL,
        address_line2 VARCHAR(255),
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NOT NULL,
        postal_code VARCHAR(20) NOT NULL,
        country VARCHAR(100) DEFAULT 'USA',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'addresses' AND column_name = 'label'
        ) THEN
          ALTER TABLE addresses ADD COLUMN label VARCHAR(100) DEFAULT 'Address';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'addresses' AND column_name = 'postal_code'
        ) THEN
          ALTER TABLE addresses ADD COLUMN postal_code VARCHAR(20);
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'addresses' AND column_name = 'pincode'
        ) THEN
          UPDATE addresses
          SET postal_code = COALESCE(postal_code, pincode)
          WHERE postal_code IS NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'addresses' AND column_name = 'country'
        ) THEN
          ALTER TABLE addresses ADD COLUMN country VARCHAR(100) DEFAULT 'India';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'addresses' AND column_name = 'updated_at'
        ) THEN
          ALTER TABLE addresses ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);

    // Create backups table if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        file_path TEXT NOT NULL,
        drive VARCHAR(20),
        file_size BIGINT DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'completed',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create Uploads table for storing images in DB (avoids lost files on redeploy)
    await client.query(`
      CREATE TABLE IF NOT EXISTS uploads (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        mimetype VARCHAR(100) NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create Contact Messages table (Contact Us: messages + complaints)
    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        message_type VARCHAR(20) NOT NULL CHECK (message_type IN ('message', 'complaint')),
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(40),
        subject VARCHAR(255),
        message TEXT NOT NULL,
        source_page VARCHAR(50) DEFAULT 'home',
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add forwarding status fields for contact email integration (safe for existing DBs)
    await client.query(`
      ALTER TABLE contact_messages
      ADD COLUMN IF NOT EXISTS email_forwarded BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS email_forwarded_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS forwarded_to VARCHAR(255),
      ADD COLUMN IF NOT EXISTS email_forward_error TEXT;
    `);

    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
      CREATE INDEX IF NOT EXISTS idx_products_homepage_section ON products(homepage_section_id);
      CREATE INDEX IF NOT EXISTS idx_cart_user ON cart(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
      CREATE INDEX IF NOT EXISTS idx_contact_messages_type_created ON contact_messages(message_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_messages_unread ON contact_messages(is_read, created_at DESC);
    `);

    // Create or replace a dynamic stock report VIEW that always reflects
    // the latest product and order data from the core tables
    await client.query(`
      CREATE OR REPLACE VIEW product_stock_report AS
      SELECT 
        p.id,
        p.name,
        p.description,
        p.category_id,
        c.name AS category_name,
        p.price,
        p.wholesale_price,
        p.stock_quantity AS current_stock,
        p.images,
        p.is_active,
        p.created_at,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0) AS total_sold,
        (p.stock_quantity + COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.quantity ELSE 0 END), 0)) AS initial_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN order_items oi ON p.id = oi.product_id
      LEFT JOIN orders o ON oi.order_id = o.id
      WHERE p.is_active = true
      GROUP BY p.id, p.name, p.description, p.category_id, c.name, p.price,
               p.wholesale_price, p.stock_quantity, p.images, p.is_active, p.created_at
      ORDER BY p.id ASC;
    `);

    // Also maintain a physical table snapshot for tools like pgAdmin
    // so stock report appears under Tables as well.
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_stock_report_table (
        id INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category_id INTEGER,
        category_name VARCHAR(100),
        price DECIMAL(10, 2),
        wholesale_price DECIMAL(10, 2),
        current_stock INTEGER,
        images JSONB,
        is_active BOOLEAN,
        created_at TIMESTAMP,
        total_sold INTEGER,
        initial_stock INTEGER
      );
    `);

    // Refresh the snapshot from the live view on startup
    await client.query('TRUNCATE TABLE product_stock_report_table');
    await client.query('INSERT INTO product_stock_report_table SELECT * FROM product_stock_report');

    // Insert default categories only when the table is empty
    // so deleted categories do not get recreated on every restart.
    const categoryCountResult = await client.query('SELECT COUNT(*)::int AS count FROM categories');
    if (categoryCountResult.rows[0].count === 0) {
      await client.query(`
        INSERT INTO categories (name, description, image_url) VALUES
        ('Fresh Produce', 'Farm-fresh fruits and vegetables', '/images/categories/produce.jpg'),
        ('Dairy Products', 'Milk, cheese, and dairy items', '/images/categories/dairy.jpg'),
        ('Bakery', 'Fresh bread and baked goods', '/images/categories/bakery.jpg'),
        ('Meat & Poultry', 'Quality meats and poultry', '/images/categories/meat.jpg'),
        ('Beverages', 'Drinks and refreshments', '/images/categories/beverages.jpg'),
        ('Snacks', 'Healthy snacks and treats', '/images/categories/snacks.jpg')
        ON CONFLICT (name) DO NOTHING;
      `);
    }

    // Insert default homepage section only when the table is empty
    const sectionCountResult = await client.query('SELECT COUNT(*)::int AS count FROM homepage_sections');
    if (sectionCountResult.rows[0].count === 0) {
      await client.query(`
        INSERT INTO homepage_sections (name, description, sort_order, is_active) VALUES
        ('Featured Products', 'Handpicked selections from our premium collection', 1, true)
        ON CONFLICT (name) DO NOTHING;
      `);
    }

    console.log('✓ Database schema initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  initializeDatabase
};
