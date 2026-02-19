const express = require('express');
const router = express.Router();
const backupController = require('../controllers/backupController');
const { authenticateToken } = require('../middleware/auth');
const { adminCheck } = require('../middleware/adminCheck');

// All backup routes require authentication and admin role
router.use(authenticateToken, adminCheck);

// Get available drives
router.get('/drives', backupController.getDrives);

// Get automatic backup scheduler settings
router.get('/auto-settings', backupController.getAutoBackupSettings);

// Update automatic backup scheduler settings
router.post('/auto-settings', backupController.updateAutoBackupSettings);

// Create a new backup
router.post('/create', backupController.createBackup);

// Get all backups
router.get('/history', backupController.getAllBackups);

// Download backup file
router.get('/:id/download', backupController.downloadBackup);

// Delete a backup record
router.delete('/:id', backupController.deleteBackup);

module.exports = router;
