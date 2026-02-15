const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const { initializeDatabase } = require('./config/database');
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 3000;

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

// File filter - Only JPG/PNG allowed
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype.toLowerCase();
    
    // Accept only if both mime type and extension are valid JPG or PNG
    if (allowedMimeTypes.includes(mimeType) && allowedExtensions.includes(ext)) {
        cb(null, true);
    } else {
        return cb(new Error('Invalid file type. Only JPG and PNG images are allowed.'), false);
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
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Image upload endpoint for admin
app.post('/api/upload', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Return the URL path to the uploaded image
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ 
      success: true,
      imageUrl,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload image' });
  }
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Setup endpoint to create admin user (one-time use)
app.get('/api/setup-admin', async (req, res) => {
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
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

// Export for Vercel
module.exports = app;