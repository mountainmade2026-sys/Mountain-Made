const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateToken } = require('../middleware/auth');
const { adminCheck, superAdminCheck } = require('../middleware/adminCheck');
const { enforceAdminLicense } = require('../middleware/adminLicense');

// All admin routes require authentication and admin role
router.use(authenticateToken);
router.use(adminCheck);

// License status is visible to admin/super admin even if blocked
router.get('/license/status', adminController.getAdminLicenseStatus);

// Super admin can manage admin license (manual block/unblock + expiry schedule)
router.post('/license/manage', superAdminCheck, adminController.updateAdminLicense);

// Block regular admin features when license is expired/blocked
router.use(enforceAdminLicense);

// Dashboard
router.get('/dashboard/stats', adminController.getDashboardStats);

// Stock Reports
router.get('/stock-reports', adminController.getStockReports);
router.get('/stock-statements', adminController.getStockStatements);

// User Management
router.get('/users', adminController.getAllUsers);
router.get('/users/wholesale', adminController.getWholesaleUsers);
router.put('/users/:userId/approve', adminController.approveWholesaleUser);
router.put('/users/:userId/block', adminController.blockUser);
router.delete('/users/:userId', adminController.deleteUser);

// Customer Management
router.get('/customers', adminController.getAllCustomers);
router.get('/customers/:id', adminController.getCustomerDetails);

// User Activities
router.get('/activities', adminController.getUserActivities);

// Product Management
router.get('/products', adminController.getAllProducts);
router.post('/products', adminController.createProduct);
router.put('/products/:id', adminController.updateProduct);
router.delete('/products/:id', adminController.deleteProduct);
router.put('/products/:id/stock', adminController.updateStock);

// Bulk Product Upload
router.post('/products/bulk', adminController.bulkUploadProducts);

// Category Management
router.get('/categories', adminController.getAllCategories);
router.post('/categories', adminController.createCategory);
router.put('/categories/:id', adminController.updateCategory);
router.delete('/categories/:id', adminController.deleteCategory);

// Order Management
router.get('/orders', adminController.getAllOrders);
router.get('/orders/:id', adminController.getOrderDetails);
router.put('/orders/:id/status', adminController.updateOrderStatus);

// Homepage Sections Management
router.get('/homepage-sections', adminController.getAllHomepageSections);
router.post('/homepage-sections', adminController.createHomepageSection);
router.post('/homepage-sections/clear-heading-images', adminController.clearAllHomepageSectionHeadingImages);
router.put('/homepage-sections/:id', adminController.updateHomepageSection);
router.delete('/homepage-sections/:id', adminController.deleteHomepageSection);

// Site Settings Management
router.get('/settings', adminController.getSiteSettings);
router.post('/settings', adminController.updateSiteSettings);
router.get('/account-settings', adminController.getAdminAccountSettings);
router.post('/account-settings', adminController.updateAdminAccountSettings);

// Support: Messages & Complaints
router.get('/contact', adminController.getContactMessages);
router.get('/contact/unread-counts', adminController.getContactUnreadCounts);
router.put('/contact/:id/read', adminController.markContactMessageRead);
router.post('/contact/:id/business-email', adminController.sendContactMessageToBusinessEmail);

// Admin outbound messaging (to customers/wholesale)
router.get('/users/search', adminController.searchUsers);
router.get('/messages/history', adminController.getAdminMessageHistory);
router.post('/messages/send', adminController.sendAdminMessage);

// Danger Zone - Delete all non-admin data
router.post('/delete-all-data', superAdminCheck, adminController.deleteAllData);

module.exports = router;