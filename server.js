const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const database = require('./config/database');
const { initializeDatabase } = database;
const User = require('./models/User');
const { authenticateToken } = require('./middleware/auth');
const { adminCheck } = require('./middleware/adminCheck');

const app = express();
const PORT = process.env.PORT || 3000;
const allowSetupEndpoints = process.env.ALLOW_SETUP_ENDPOINTS === 'true';

app.disable('x-powered-by');
// Ensure req.secure and related proxy-derived fields behave correctly on Render/other proxies.
app.set('trust proxy', 1);

// Avoid stale HTML/JS on hosted deployments (fixes old auth logic being served).
app.use((req, res, next) => {
  const pathname = req.path;
  const isAuthCriticalHtml = pathname === '/admin' || pathname === '/login' || pathname === '/register' || pathname.endsWith('.html');
  const isAuthCriticalJs = pathname === '/js/main.js' || pathname === '/sw.js';
  if (isAuthCriticalHtml || isAuthCriticalJs) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// File filter - Only JPG/PNG/GIF allowed
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/gif'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype.toLowerCase();
    
    // Accept only if both mime type and extension are valid JPG, PNG, or GIF
    if (allowedMimeTypes.includes(mimeType) && allowedExtensions.includes(ext)) {
        cb(null, true);
    } else {
      return cb(new Error('Invalid file type. Only JPG, PNG, and GIF images are allowed.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Page-level access guard: keep wholesale and public experiences separated.
// - Approved wholesale users are redirected away from public browsing pages.
// - Non-wholesale users are redirected away from the wholesale portal.
// Note: This only guards HTML page routes (not API endpoints).
app.use((req, res, next) => {
  try {
    const method = String(req.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();

    const pathname = req.path || '/';
    const wholesalePages = new Set(['/wholesale', '/wholesale.html']);
    const publicOnlyPages = new Set([
      '/',
      '/index.html',
      '/products',
      '/products.html',
      '/product-details',
      '/product-details.html',
      '/orders',
      '/orders.html',
      '/contact',
      '/contact.html',
      '/login',
      '/login.html',
      '/register',
      '/register.html'
    ]);

    const isWholesalePage = wholesalePages.has(pathname);
    const isPublicOnlyPage = publicOnlyPages.has(pathname);
    if (!isWholesalePage && !isPublicOnlyPage) return next();

    const sanitizeToken = (token) => {
      if (!token) return null;
      const value = String(token).trim().replace(/^"|"$/g, '');
      return value || null;
    };

    const rawAuth = req.get('authorization') || req.get('Authorization') || '';
    const bearerMatch = String(rawAuth).match(/^Bearer\s+(.+)$/i);
    const headerToken = bearerMatch && bearerMatch[1] ? sanitizeToken(bearerMatch[1]) : sanitizeToken(rawAuth);
    const cookieToken = sanitizeToken(req.cookies?.token);
    const token = headerToken || cookieToken;

    let claims = null;
    if (token && process.env.JWT_SECRET) {
      try {
        claims = jwt.verify(token, process.env.JWT_SECRET);
      } catch (_) {
        claims = null;
      }
    }

    const isBlocked = !!claims?.is_blocked;
    const role = claims?.role;
    const isApprovedWholesale = !isBlocked && role === 'wholesale' && !!claims?.is_approved;
    const isAdmin = !isBlocked && (role === 'admin' || role === 'super_admin');

    if (isWholesalePage) {
      if (isApprovedWholesale || isAdmin) return next();

      if (!claims) {
        return res.redirect(302, `/login?redirect=${encodeURIComponent('/wholesale')}`);
      }

      if (role === 'wholesale' && !claims?.is_approved) {
        return res.redirect(302, '/');
      }

      if (isBlocked) {
        return res.redirect(302, '/login');
      }

      return res.redirect(302, '/');
    }

    if (isPublicOnlyPage) {
      if (isApprovedWholesale) {
        const sendToCatalog = pathname === '/products' || pathname === '/products.html' || pathname === '/product-details' || pathname === '/product-details.html';
        return res.redirect(302, sendToCatalog ? '/wholesale#catalog' : '/wholesale');
      }
      return next();
    }

    return next();
  } catch (err) {
    return next();
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// DB-backed upload fetch (survives redeploys)
app.get('/uploads/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return next();
    }

    const result = await database.query('SELECT mimetype, data FROM uploads WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Not found');
    }

    const row = result.rows[0];
    res.setHeader('Content-Type', row.mimetype);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(row.data);
  } catch (err) {
    console.error('Serve upload error:', err);
    return res.status(500).send('Failed to fetch upload');
  }
});

// Static fallback for any legacy on-disk uploads
app.use('/uploads', express.static(uploadDir));

// Legacy image upload endpoint for admin (kept for backward compatibility)
app.post('/api/upload', authenticateToken, adminCheck, upload.single('image'), (req, res) => {
  (async () => {
    try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let imageUrl = `/uploads/${req.file.filename}`;

    try {
      const fileBuffer = await fs.promises.readFile(req.file.path);
      const saved = await database.query(
        'INSERT INTO uploads (filename, mimetype, data) VALUES ($1, $2, $3) RETURNING id',
        [req.file.originalname || req.file.filename, req.file.mimetype || 'application/octet-stream', fileBuffer]
      );
      const uploadId = saved.rows?.[0]?.id;
      if (uploadId) {
        imageUrl = `/uploads/${uploadId}`;
      }
    } catch (persistError) {
      console.warn('Legacy upload DB persist warning:', persistError.message || persistError);
    }

    res.json({ 
      success: true,
      imageUrl,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload image' });
  }
  })();
});

// Handle upload errors
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: error.message });
  }
  next(error);
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/addresses', require('./routes/addresses'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/restore', require('./routes/restore'));
app.use('/api/contact', require('./routes/contact'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// DB diagnostics endpoint for restore/schema troubleshooting
app.get('/api/health/db', async (req, res) => {
  try {
    const checks = {};

    const tableCheck = await database.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users','products','categories','homepage_sections','orders','order_items','addresses','site_settings','cart','contact_messages','backups')
      ORDER BY table_name
    `);
    checks.tables = tableCheck.rows.map(r => r.table_name);

    const productColumns = await database.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products'
      ORDER BY ordinal_position
    `);
    checks.productColumns = productColumns.rows.map(r => r.column_name);

    const categoryColumns = await database.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'categories'
      ORDER BY ordinal_position
    `);
    checks.categoryColumns = categoryColumns.rows.map(r => r.column_name);

    const sectionColumns = await database.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'homepage_sections'
      ORDER BY ordinal_position
    `);
    checks.sectionColumns = sectionColumns.rows.map(r => r.column_name);

    const counts = await database.query(`
      SELECT
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM categories) AS categories,
        (SELECT COUNT(*)::int FROM homepage_sections) AS sections,
        (SELECT COUNT(*)::int FROM users) AS users
    `);
    checks.counts = counts.rows[0];

    res.json({ ok: true, checks });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null
    });
  }
});

// Setup endpoint to create admin user (one-time use)
app.get('/api/setup-admin', async (req, res) => {
  if (!allowSetupEndpoints) {
    return res.status(403).json({
      success: false,
      error: 'Setup endpoints are disabled. Set ALLOW_SETUP_ENDPOINTS=true only for trusted setup.'
    });
  }

  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@mountainmade.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';

    await User.ensureAdmin(adminEmail, adminPassword);

    res.json({ 
      success: true, 
      message: 'Admin user ensured successfully',
      email: adminEmail
    });
  } catch (error) {
    console.error('Setup admin error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Setup endpoint to create super admin user (one-time use)
app.get('/api/setup-super-admin', async (req, res) => {
  if (!allowSetupEndpoints) {
    return res.status(403).json({
      success: false,
      error: 'Setup endpoints are disabled. Set ALLOW_SETUP_ENDPOINTS=true only for trusted setup.'
    });
  }

  try {
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'developer@mountainmade.com';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123';

    await User.ensureSuperAdmin(superAdminEmail, superAdminPassword);

    res.json({
      success: true,
      message: 'Super admin user ensured successfully',
      email: superAdminEmail
    });
  } catch (error) {
    console.error('Setup super admin error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve HTML pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'products.html'));
});

app.get('/cart', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cart.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

app.get('/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'orders.html'));
});

app.get('/product-details', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product-details.html'));
});

app.get('/addresses', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'addresses.html'));
});

app.get('/wholesale', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wholesale.html'));
});

app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Initialize database and create admin user
const initializeApp = async () => {
  try {
    await initializeDatabase();

    // Create default admin user if not exists
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@mountainmade.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';

    await User.ensureAdmin(adminEmail, adminPassword);
    console.log(`✓ Admin user ensured: ${adminEmail}`);

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'developer@mountainmade.com';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123';
    await User.ensureSuperAdmin(superAdminEmail, superAdminPassword);
    console.log(`✓ Super admin user ensured: ${superAdminEmail}`);

    const enableTestAccounts = String(process.env.ENABLE_TEST_ACCOUNTS || '').trim().toLowerCase() === 'true';
    if (enableTestAccounts) {
      const testCustomerEmail = String(process.env.TEST_CUSTOMER_EMAIL || '').trim();
      const testCustomerPassword = String(process.env.TEST_CUSTOMER_PASSWORD || '').trim();
      if (testCustomerEmail && testCustomerPassword) {
        await User.ensureTestCustomer(testCustomerEmail, testCustomerPassword);
        console.log(`✓ Test customer ensured: ${testCustomerEmail}`);
      } else {
        console.warn('⚠️  ENABLE_TEST_ACCOUNTS=true but TEST_CUSTOMER_EMAIL/TEST_CUSTOMER_PASSWORD not fully set. Skipping test customer.');
      }

      const testWholesaleEmail = String(process.env.TEST_WHOLESALE_EMAIL || '').trim();
      const testWholesalePassword = String(process.env.TEST_WHOLESALE_PASSWORD || '').trim();
      if (testWholesaleEmail && testWholesalePassword) {
        await User.ensureTestWholesale(testWholesaleEmail, testWholesalePassword);
        console.log(`✓ Test wholesale ensured: ${testWholesaleEmail}`);
      } else {
        console.warn('⚠️  ENABLE_TEST_ACCOUNTS=true but TEST_WHOLESALE_EMAIL/TEST_WHOLESALE_PASSWORD not fully set. Skipping test wholesale.');
      }
    }

    console.log('✓ Application initialized successfully');
  } catch (error) {
    console.error('Application initialization failed:', error);
    // Don't exit on Vercel, just log the error
    if (process.env.VERCEL !== '1') {
      process.exit(1);
    }
  }
};

// Initialize the app immediately for Vercel
initializeApp();

// Only start server if not running on Vercel (for local development)
if (process.env.VERCEL !== '1' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║           🏔️  MOUNTAIN MADE 2.0                      ║
║           Food E-Commerce Platform                    ║
║                                                       ║
║   Server running on: http://localhost:${PORT}        ║
║                                                       ║
║   Admin Panel: http://localhost:${PORT}/admin        ║
║   Admin Email: ${process.env.ADMIN_EMAIL || 'admin@mountainmade.com'}            ║
║   Super Admin Email: ${process.env.SUPER_ADMIN_EMAIL || 'developer@mountainmade.com'}     ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

// Export for Vercel
module.exports = app;