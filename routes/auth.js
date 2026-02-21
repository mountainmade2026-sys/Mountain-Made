const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

const authRateStore = new Map();

const authRateLimit = ({ windowMs, maxAttempts }) => (req, res, next) => {
	const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
	const loginIdentifier = String(req.body?.identifier || req.body?.email || req.body?.phone || '').trim().toLowerCase();
	const key = `${ip}:${loginIdentifier}:${req.path}`;
	const now = Date.now();

	const existing = authRateStore.get(key);
	if (!existing || existing.expiresAt <= now) {
		authRateStore.set(key, { count: 1, expiresAt: now + windowMs });
		return next();
	}

	if (existing.count >= maxAttempts) {
		const retryAfter = Math.ceil((existing.expiresAt - now) / 1000);
		res.set('Retry-After', String(retryAfter));
		return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
	}

	existing.count += 1;
	authRateStore.set(key, existing);
	return next();
};

const loginRateLimit = authRateLimit({ windowMs: 15 * 60 * 1000, maxAttempts: 8 });
const registerRateLimit = authRateLimit({ windowMs: 60 * 60 * 1000, maxAttempts: 5 });
const otpSendRateLimit = authRateLimit({ windowMs: 10 * 60 * 1000, maxAttempts: 6 });
const otpVerifyRateLimit = authRateLimit({ windowMs: 10 * 60 * 1000, maxAttempts: 10 });

// Public routes
router.post('/register', registerRateLimit, authController.register);
router.post('/login', loginRateLimit, authController.login);
router.get('/google/config', authController.getGoogleConfig);
router.post('/google', registerRateLimit, authController.googleAuth);
router.post('/phone/send-otp', otpSendRateLimit, authController.sendPhoneOtp);
router.post('/phone/verify-otp', otpVerifyRateLimit, authController.verifyPhoneOtp);
router.post('/phone/login/send-otp', otpSendRateLimit, authController.sendPhoneLoginOtp);
router.post('/phone/login/verify-otp', otpVerifyRateLimit, authController.verifyPhoneLoginOtp);
router.post('/logout', authController.logout);
router.get('/check', optionalAuth, authController.checkAuth);

// Protected routes
router.get('/profile', authenticateToken, authController.getProfile);
router.put('/profile', authenticateToken, authController.updateProfile);
router.put('/change-password', authenticateToken, authController.changePassword);

module.exports = router;
