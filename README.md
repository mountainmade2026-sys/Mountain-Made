# Mountain Made 2.0 - Professional Food E-Commerce Platform

A full-stack, professional food e-commerce platform built with Node.js, Express, PostgreSQL, and vanilla JavaScript. Features include customer shopping, wholesale accounts with approval workflow, and complete admin management.

## 🌟 Features

### Customer Features
- Browse products by category
- Advanced product search and filtering
- Shopping cart with real-time updates
- Secure checkout process
- Order tracking and history
- User profile management

### Wholesale Features
- Dedicated wholesale pricing
- Bulk order capabilities
- Business account registration
- Approval workflow system
- Minimum order quantities

### Admin Features
- Complete dashboard with statistics
- Product management (CRUD operations)
- Order management and status updates
- User management
- Wholesale account approval
- Real-time inventory tracking

## 🛠️ Technology Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL
- **Authentication**: JWT (JSON Web Tokens)
- **Password Security**: bcryptjs
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Icons**: Font Awesome 6

## 📋 Prerequisites

Before you begin, ensure you have the following installed:
- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- pgAdmin (for database management)
- npm (comes with Node.js)

## 🚀 Installation & Setup

### 1. Database Setup (PostgreSQL)

**Option A: Using pgAdmin**
1. Open pgAdmin
2. Create a new database named `mountain_made`
3. The application will automatically create all tables on first run

**Option B: Using Command Line**
```bash
# Login to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE mountain_made;

# Exit
\q
```

### 2. Project Setup

1. **Navigate to project directory**
```bash
cd mountain-made-ecommerce
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment variables**
```bash
# Copy the example env file
cp .env.example .env

# Edit .env with your settings
```

Edit the `.env` file with your PostgreSQL credentials:
```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_postgresql_password
DB_NAME=mountain_made

# Server Configuration
PORT=3000
NODE_ENV=development

# JWT Secret (IMPORTANT: Change this to a strong random string)
JWT_SECRET=your_very_secure_random_jwt_secret_key_here

# Admin Credentials
ADMIN_EMAIL=admin@mountainmade.com
ADMIN_PASSWORD=Admin@123

# Super Admin Credentials
SUPER_ADMIN_EMAIL=developer@mountainmade.com
SUPER_ADMIN_PASSWORD=SuperAdmin@123

# Optional: Auto-create test accounts on startup (useful for Render testing)
ENABLE_TEST_ACCOUNTS=false
TEST_CUSTOMER_EMAIL=test.customer@mountainmade.local
TEST_CUSTOMER_PASSWORD=change_me
TEST_WHOLESALE_EMAIL=test.wholesale@mountainmade.local
TEST_WHOLESALE_PASSWORD=change_me
```

**⚠️ IMPORTANT**: 
- Replace `your_postgresql_password` with your actual PostgreSQL password
- Change `JWT_SECRET` to a strong, random string for production
- Update admin credentials for security

### 3. Initialize Database

The application will automatically:
- Create all necessary tables
- Set up indexes for optimal performance
- Insert default categories
- Create the admin user account

Simply start the server and the database will be initialized:

```bash
npm start
```

You should see:
```
✓ Connected to PostgreSQL database
Initializing database schema...
✓ Database schema initialized successfully
✓ Admin user created: admin@mountainmade.com
✓ Application initialized successfully

╔═══════════════════════════════════════════════════════╗
║                                                       ║
║           🏔️  MOUNTAIN MADE 2.0                      ║
║           Food E-Commerce Platform                    ║
║                                                       ║
║   Server running on: http://localhost:3000           ║
║                                                       ║
║   Admin Panel: http://localhost:3000/admin           ║
║   Admin Email: admin@mountainmade.com                ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
```

### 4. Access the Application

Open your browser and navigate to:

**Main Website**: http://localhost:3000

**Admin Panel**: http://localhost:3000/admin
- Email: admin@mountainmade.com
- Password: Admin@123 (or your custom password from .env)

## 📱 User Accounts

### Optional temporary test accounts (Render/local)

If you want the app to create a **test customer** and a **test wholesale** account automatically (for temporary testing on Render), set these environment variables and restart the service:

```env
ENABLE_TEST_ACCOUNTS=true
TEST_CUSTOMER_EMAIL=your_test_customer_email
TEST_CUSTOMER_PASSWORD=your_test_customer_password
TEST_WHOLESALE_EMAIL=your_test_wholesale_email
TEST_WHOLESALE_PASSWORD=your_test_wholesale_password
```

Then you can log in normally from `/login`.

**Important**: turn it off after testing by setting `ENABLE_TEST_ACCOUNTS=false` (or removing the vars) and redeploying.

### Admin Account
- **Email**: admin@mountainmade.com
- **Password**: Admin@123 (default)
- **Features**: Full system access, user management, product management

### Customer Registration
1. Go to http://localhost:3000/register
2. Select "Customer" account type
3. Fill in the registration form
4. Start shopping immediately

### Wholesale Registration
1. Go to http://localhost:3000/register?type=wholesale
2. Select "Wholesale" account type
3. Provide business information (Business Name, Tax ID)
4. Wait for admin approval
5. Access wholesale pricing after approval

## 🗂️ Project Structure

```
mountain-made-ecommerce/
├── server.js                 # Main server file
├── package.json             # Dependencies
├── .env                     # Environment variables (create from .env.example)
│
├── config/
│   └── database.js         # PostgreSQL connection & schema
│
├── routes/
│   ├── auth.js            # Authentication routes
│   ├── products.js        # Product routes
│   ├── cart.js           # Shopping cart routes
│   ├── orders.js         # Order management routes
│   └── admin.js          # Admin panel routes
│
├── controllers/
│   ├── authController.js     # Authentication logic
│   ├── productController.js  # Product operations
│   ├── cartController.js     # Cart management
│   └── adminController.js    # Admin operations
│
├── models/
│   ├── User.js          # User model
│   ├── Product.js       # Product model
│   └── Order.js         # Order model
│
├── middleware/
│   ├── auth.js         # JWT authentication
│   └── adminCheck.js   # Admin authorization
│
└── public/
    ├── index.html      # Home page
    ├── products.html   # Products listing
    ├── cart.html       # Shopping cart
    ├── checkout.html   # Checkout page
    ├── orders.html     # Order history
    ├── login.html      # Login page
    ├── register.html   # Registration page
    ├── admin.html      # Admin panel
    │
    ├── css/
    │   └── styles.css  # Main stylesheet
    │
    ├── js/
    │   └── main.js     # Main JavaScript utilities
    │
    └── images/         # Product images (add your images here)
```

## 📊 Database Schema

The application uses the following tables:

1. **users** - User accounts (customers, wholesale, admin)
2. **categories** - Product categories
3. **products** - Product inventory
4. **cart** - Shopping cart items
5. **orders** - Order records
6. **order_items** - Individual order line items

## 🔐 Security Features

- JWT-based authentication
- HTTP-only cookies for token storage
- Password hashing with bcryptjs
- Role-based access control (RBAC)
- SQL injection protection via parameterized queries
- Input validation and sanitization

## 🎨 Customization

### Adding Product Images
Place your product images in the `public/images/` directory and reference them in the database.

### Modifying Styles
Edit `public/css/styles.css` to customize the look and feel. The design uses CSS variables for easy theming.

### Adding Categories
Categories are automatically created during initialization. To add more:
1. Log in as admin
2. Use the admin panel to add new categories

### Sample Products
To add sample products for testing:
1. Log in as admin at http://localhost:3000/admin
2. Navigate to "Products Management"
3. Click "Add Product"
4. Fill in product details and save

## 🛒 Testing Workflow

1. **Admin Setup**
   - Login as admin (admin@mountainmade.com / Admin@123)
   - Add product categories (if needed)
   - Add sample products with images and prices

2. **Customer Testing**
   - Register a new customer account
   - Browse products
   - Add items to cart
   - Complete checkout process
   - View order history

3. **Wholesale Testing**
   - Register a wholesale account with business details
   - Wait for admin approval (or approve yourself as admin)
   - Login and see wholesale pricing
   - Place bulk orders

## 📝 API Endpoints

### Authentication
- POST `/api/auth/register` - Register new user
- POST `/api/auth/login` - User login
- POST `/api/auth/logout` - User logout
- GET `/api/auth/profile` - Get user profile
- GET `/api/auth/check` - Check authentication status

### Products
- GET `/api/products` - Get all products
- GET `/api/products/:id` - Get single product
- GET `/api/products/categories` - Get all categories

### Cart
- GET `/api/cart` - Get user's cart
- POST `/api/cart/add` - Add item to cart
- PUT `/api/cart/:id` - Update cart item
- DELETE `/api/cart/:id` - Remove cart item

### Orders
- POST `/api/orders` - Create new order
- GET `/api/orders` - Get user's orders
- GET `/api/orders/:id` - Get single order

### Admin (Requires Admin Role)
- GET `/api/admin/dashboard/stats` - Dashboard statistics
- GET `/api/admin/users` - Get all users
- GET `/api/admin/users/wholesale` - Get wholesale requests
- PUT `/api/admin/users/:id/approve` - Approve/reject wholesale
- POST `/api/admin/products` - Create product
- PUT `/api/admin/products/:id` - Update product
- DELETE `/api/admin/products/:id` - Delete product
- GET `/api/admin/orders` - Get all orders
- PUT `/api/admin/orders/:id/status` - Update order status

## 🐛 Troubleshooting

### Database Connection Issues
```bash
# Check if PostgreSQL is running
# Windows: Check Services
# Mac: brew services list
# Linux: sudo systemctl status postgresql

# Test connection with psql
psql -U postgres -d mountain_made
```

### Port Already in Use
```bash
# Change PORT in .env file
PORT=3001
```

### Module Not Found Errors
```bash
# Reinstall dependencies
rm -rf node_modules
npm install
```

### Database Schema Issues
If you need to reset the database:
```bash
# Drop and recreate database (WARNING: This deletes all data)
psql -U postgres
DROP DATABASE mountain_made;
CREATE DATABASE mountain_made;
\q

# Restart the application to reinitialize
npm start
```

## 🔄 Development Mode

For development with auto-restart on file changes:

```bash
npm run dev
```

This requires nodemon, which is included in devDependencies.

## 📦 Production Deployment

For production deployment:

1. Set `NODE_ENV=production` in your environment
2. Use a strong `JWT_SECRET`
3. Configure proper database security
4. Set up HTTPS/SSL
5. Configure CORS for your domain
6. Use a process manager (PM2 recommended)

```bash
# Install PM2
npm install -g pm2

# Start application with PM2
pm2 start server.js --name mountain-made

# Configure auto-restart
pm2 startup
pm2 save
```

## 🤝 Support

For issues or questions:
- Check the troubleshooting section
- Review the code comments
- Verify your PostgreSQL connection
- Ensure all environment variables are set correctly

## 📄 License

This project is created for educational and commercial purposes.

## 🎉 Enjoy!

Your Mountain Made 2.0 e-commerce platform is now ready to use. Happy selling! 🏔️
