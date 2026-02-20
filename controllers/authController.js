const User = require('../models/User');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const twilio = require('twilio');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || process.env.VERIFY_SERVICE_SID || '';

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id, 
      email: user.email, 
      role: user.role,
      is_approved: user.is_approved,
      is_blocked: user.is_blocked 
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

const isHttpsRequest = (req) => {
  const directSecure = !!req.secure;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return directSecure || forwardedProto === 'https';
};

const isAdminLikeRole = (role) => role === 'admin' || role === 'super_admin';

const buildCookieOptions = (req, userRole = null) => {
  const forceSecure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
  const options = {
    httpOnly: true,
    secure: forceSecure ? true : isHttpsRequest(req),
    sameSite: 'lax',
    path: '/'
  };

  // Keep customer/wholesale login persistent, but make admin login session-only.
  if (!isAdminLikeRole(userRole)) {
    options.maxAge = 7 * 24 * 60 * 60 * 1000;
  }

  return options;
};

const normalizePhoneToE164 = (phone) => {
  const raw = String(phone || '').trim();
  if (!raw) {
    throw new Error('Phone number is required.');
  }

  if (raw.startsWith('+')) {
    if (!/^\+\d{8,15}$/.test(raw)) {
      throw new Error('Phone number must be a valid international number.');
    }
    return raw;
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+91${digits}`;
  }

  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  throw new Error('Phone number must contain 8 to 15 digits.');
};

const createPhoneVerificationToken = (phoneE164) => jwt.sign(
  {
    purpose: 'phone_register_verification',
    phone: phoneE164
  },
  process.env.JWT_SECRET,
  { expiresIn: '15m' }
);

const verifyPhoneVerificationToken = (token) => {
  try {
    const decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    if (decoded?.purpose !== 'phone_register_verification' || !decoded?.phone) {
      return null;
    }
    return decoded;
  } catch (_) {
    return null;
  }
};

const validateWholesaleFields = ({ role, business_name, tax_id, address_line1, city, state, postal_code }) => {
  if (role === 'wholesale' && (!business_name || !tax_id || !address_line1 || !city || !state || !postal_code)) {
    return 'Business name, tax ID, and address are required for wholesale accounts.';
  }
  return null;
};

const createWholesaleAddress = async (userId, {
  full_name,
  phone,
  address_line1,
  address_line2,
  city,
  state,
  postal_code
}) => {
  await db.query(
    `INSERT INTO addresses
     (user_id, label, full_name, phone, address_line1, address_line2, city, state, postal_code, country, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      userId,
      'Business Address',
      full_name,
      phone,
      address_line1,
      address_line2 || null,
      city,
      state,
      postal_code,
      'India',
      true
    ]
  );
};

exports.register = async (req, res) => {
  try {
    const {
      email,
      password,
      full_name,
      phone,
      phone_verification_token,
      role,
      business_name,
      tax_id,
      address_line1,
      address_line2,
      city,
      state,
      postal_code
    } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();

    // Validate required fields
    if (!normalizedEmail || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }

    const normalizedPhone = normalizePhoneToE164(phone);
    const decodedPhoneToken = verifyPhoneVerificationToken(phone_verification_token);
    if (!decodedPhoneToken || decodedPhoneToken.phone !== normalizedPhone) {
      return res.status(400).json({ error: 'Phone verification is required before registration.' });
    }

    // Check if user exists
    const existingUser = await User.findByEmail(normalizedEmail);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }

    const wholesaleValidationError = validateWholesaleFields({
      role,
      business_name,
      tax_id,
      address_line1,
      city,
      state,
      postal_code
    });
    if (wholesaleValidationError) {
      return res.status(400).json({ error: wholesaleValidationError });
    }

    // Create user
    const user = await User.create({
      email: normalizedEmail,
      password,
      full_name,
      phone: normalizedPhone,
      role: role || 'customer',
      business_name,
      tax_id
    });

    // If wholesale, create a default saved address during registration
    if ((role || 'customer') === 'wholesale') {
      try {
        await createWholesaleAddress(user.id, {
          full_name,
          phone: normalizedPhone,
          address_line1,
          address_line2,
          city,
          state,
          postal_code
        });
      } catch (addrErr) {
        // Roll back user creation if address insert fails
        try {
          await db.query('DELETE FROM users WHERE id = $1', [user.id]);
        } catch (cleanupErr) {
          console.error('Failed to rollback user after address insert error:', cleanupErr);
        }
        console.error('Wholesale address insert error:', addrErr);
        return res.status(500).json({ error: 'Registration failed. Please try again.' });
      }
    }

    const token = generateToken(user);

    res.cookie('token', token, buildCookieOptions(req, user.role));

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_approved: user.is_approved,
        profile_photo: user.profile_photo
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, identifier, phone, password } = req.body || {};

    const rawIdentifier = String(identifier || email || phone || '').trim();
    if (!rawIdentifier || !password) {
      return res.status(400).json({ error: 'Email/phone and password are required.' });
    }

    const looksLikeEmail = rawIdentifier.includes('@');
    let user = null;

    if (looksLikeEmail) {
      const normalizedEmail = rawIdentifier.toLowerCase();
      user = await User.findByEmail(normalizedEmail);
    } else {
      let normalizedPhone;
      try {
        normalizedPhone = normalizePhoneToE164(rawIdentifier);
      } catch (_) {
        normalizedPhone = rawIdentifier;
      }
      user = await User.findByPhone(normalizedPhone);
      if (!user) {
        user = await User.findByPhone(rawIdentifier);
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid email/phone or password.' });
    }

    // Check if user is blocked
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }

    // Verify password
    const isValidPassword = await User.verifyPassword(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email/phone or password.' });
    }

    // Generate token
    const token = generateToken(user);

    res.cookie('token', token, buildCookieOptions(req, user.role));

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_approved: user.is_approved,
        profile_photo: user.profile_photo
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
};

exports.getGoogleConfig = async (_req, res) => {
  res.json({
    enabled: !!GOOGLE_CLIENT_ID,
    clientId: GOOGLE_CLIENT_ID || null
  });
};

exports.googleAuth = async (req, res) => {
  try {
    const {
      id_token,
      role,
      full_name,
      phone,
      phone_verification_token,
      business_name,
      tax_id,
      address_line1,
      address_line2,
      city,
      state,
      postal_code
    } = req.body || {};

    if (!googleClient || !GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google sign-in is not configured.' });
    }

    if (!id_token) {
      return res.status(400).json({ error: 'Google token is required.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.email_verified) {
      return res.status(400).json({ error: 'Google account email is not verified.' });
    }

    const normalizedEmail = String(payload.email || '').trim().toLowerCase();
    const existingUser = await User.findByEmail(normalizedEmail);

    if (existingUser) {
      if (existingUser.is_blocked) {
        return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
      }

      const token = generateToken(existingUser);
      res.cookie('token', token, buildCookieOptions(req, existingUser.role));
      return res.json({
        message: 'Login successful',
        token,
        user: {
          id: existingUser.id,
          email: existingUser.email,
          full_name: existingUser.full_name,
          role: existingUser.role,
          is_approved: existingUser.is_approved,
          profile_photo: existingUser.profile_photo
        }
      });
    }

    const selectedRole = role === 'wholesale' ? 'wholesale' : 'customer';
    const fallbackName = String(full_name || payload.name || 'Google User').trim();
    const normalizedPhone = normalizePhoneToE164(phone);

    const decodedPhoneToken = verifyPhoneVerificationToken(phone_verification_token);
    if (!decodedPhoneToken || decodedPhoneToken.phone !== normalizedPhone) {
      return res.status(400).json({ error: 'Phone verification is required before registration.' });
    }

    const wholesaleValidationError = validateWholesaleFields({
      role: selectedRole,
      business_name,
      tax_id,
      address_line1,
      city,
      state,
      postal_code
    });
    if (wholesaleValidationError) {
      return res.status(400).json({ error: wholesaleValidationError });
    }

    const generatedPassword = crypto.randomBytes(24).toString('hex');
    const user = await User.create({
      email: normalizedEmail,
      password: generatedPassword,
      full_name: fallbackName,
      phone: normalizedPhone,
      role: selectedRole,
      business_name,
      tax_id
    });

    if (selectedRole === 'wholesale') {
      await createWholesaleAddress(user.id, {
        full_name: fallbackName,
        phone: normalizedPhone,
        address_line1,
        address_line2,
        city,
        state,
        postal_code
      });
    }

    const token = generateToken(user);
    res.cookie('token', token, buildCookieOptions(req, user.role));

    return res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_approved: user.is_approved,
        profile_photo: user.profile_photo
      }
    });
  } catch (error) {
    console.error('Google auth error:', error);
    return res.status(500).json({ error: 'Google sign-in failed.' });
  }
};

exports.sendPhoneOtp = async (req, res) => {
  try {
    if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
      return res.status(503).json({ error: 'Phone OTP is not configured on server.' });
    }

    const phoneE164 = normalizePhoneToE164(req.body?.phone);

    await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
      .verifications
      .create({ to: phoneE164, channel: 'sms' });

    return res.json({ message: 'OTP sent successfully.', phone: phoneE164 });
  } catch (error) {
    console.error('Send phone OTP error:', error);
    return res.status(400).json({ error: 'Failed to send OTP. Please check phone number.' });
  }
};

exports.verifyPhoneOtp = async (req, res) => {
  try {
    if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
      return res.status(503).json({ error: 'Phone OTP is not configured on server.' });
    }

    const phoneE164 = normalizePhoneToE164(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'OTP code is required.' });
    }

    const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks
      .create({ to: phoneE164, code });

    if (String(check.status || '').toLowerCase() !== 'approved') {
      return res.status(400).json({ error: 'Invalid OTP code.' });
    }

    const phoneVerificationToken = createPhoneVerificationToken(phoneE164);
    return res.json({
      message: 'Phone verified successfully.',
      phone: phoneE164,
      phone_verification_token: phoneVerificationToken
    });
  } catch (error) {
    console.error('Verify phone OTP error:', error);
    return res.status(400).json({ error: 'OTP verification failed.' });
  }
};

exports.sendPhoneLoginOtp = async (req, res) => {
  try {
    if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
      return res.status(503).json({ error: 'Phone OTP is not configured on server.' });
    }

    const phoneE164 = normalizePhoneToE164(req.body?.phone);
    const existingUser = await User.findByPhone(phoneE164);

    if (!existingUser) {
      return res.status(404).json({ error: 'This phone number is not registered.' });
    }

    if (existingUser.is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }

    await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
      .verifications
      .create({ to: phoneE164, channel: 'sms' });

    return res.json({ message: 'OTP sent successfully.', phone: phoneE164 });
  } catch (error) {
    console.error('Send phone login OTP error:', error);
    return res.status(400).json({ error: 'Failed to send OTP. Please check phone number.' });
  }
};

exports.verifyPhoneLoginOtp = async (req, res) => {
  try {
    if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
      return res.status(503).json({ error: 'Phone OTP is not configured on server.' });
    }

    const phoneE164 = normalizePhoneToE164(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'OTP code is required.' });
    }

    const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks
      .create({ to: phoneE164, code });

    if (String(check.status || '').toLowerCase() !== 'approved') {
      return res.status(400).json({ error: 'Invalid OTP code.' });
    }

    const user = await User.findByPhone(phoneE164);
    if (!user) {
      return res.status(404).json({ error: 'This phone number is not registered.' });
    }

    if (user.is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }

    const token = generateToken(user);
    res.cookie('token', token, buildCookieOptions(req, user.role));

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_approved: user.is_approved,
        profile_photo: user.profile_photo
      }
    });
  } catch (error) {
    console.error('Verify phone login OTP error:', error);
    return res.status(400).json({ error: 'OTP verification failed.' });
  }
};

exports.logout = (req, res) => {
  res.clearCookie('token', buildCookieOptions(req));
  res.json({ message: 'Logout successful' });
};

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { full_name, phone, profile_photo } = req.body;
    const user = await User.updateProfile(req.user.id, { full_name, phone, profile_photo });
    
    res.json({ 
      message: 'Profile updated successfully',
      user 
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
};

exports.checkAuth = async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ authenticated: false });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_approved: user.is_approved,
        profile_photo: user.profile_photo
      }
    });
  } catch (error) {
    res.json({ authenticated: false });
  }
};
