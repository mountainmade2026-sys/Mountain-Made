const express = require('express');
const router = express.Router();
const db = require('../config/database');
const nodemailer = require('nodemailer');
const https = require('https');
const { optionalAuth } = require('../middleware/auth');

const DEFAULT_SUPPORT_EMAIL = 'hello@mountain-made.com';

const SMTP_CONNECTION_TIMEOUT_MS = parseInt(process.env.SMTP_CONNECTION_TIMEOUT_MS || '10000', 10);
const SMTP_GREETING_TIMEOUT_MS = parseInt(process.env.SMTP_GREETING_TIMEOUT_MS || '10000', 10);
const SMTP_SOCKET_TIMEOUT_MS = parseInt(process.env.SMTP_SOCKET_TIMEOUT_MS || '15000', 10);
const CONTACT_EMAIL_FORWARD_TIMEOUT_MS = parseInt(process.env.CONTACT_EMAIL_FORWARD_TIMEOUT_MS || '12000', 10);

const RESEND_REQUEST_TIMEOUT_MS = parseInt(process.env.RESEND_REQUEST_TIMEOUT_MS || '12000', 10);

function withTimeout(promise, timeoutMs, label = 'operation') {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function httpJsonRequest({ method, hostname, path, headers, body, timeoutMs }) {
  const payload = body ? JSON.stringify(body) : '';
  const requestHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...(headers || {})
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: method || 'POST',
        hostname,
        path,
        headers: requestHeaders
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (_) {
              parsed = null;
            }
          }

          if (statusCode >= 200 && statusCode < 300) {
            return resolve({ statusCode, data: parsed, raw: data });
          }

          const msg =
            (parsed && (parsed.message || parsed.error)) ||
            data ||
            `HTTP ${statusCode}`;
          const err = new Error(msg);
          err.statusCode = statusCode;
          err.response = parsed;
          return reject(err);
        });
      }
    );

    const ms = Number(timeoutMs);
    if (Number.isFinite(ms) && ms > 0) {
      req.setTimeout(ms, () => {
        req.destroy(new Error(`HTTP request timed out after ${ms}ms`));
      });
    }

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function normalizeEmailAddress(value) {
  const v = String(value || '').trim().replace(/^"|"$/g, '');
  if (!v) return null;

  // Plain email.
  const emailOnly = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (emailOnly.test(v)) return v;

  // Friendly name format: Name <email@domain.com>
  const match = v.match(/^.*<\s*([^>\s]+)\s*>\s*$/);
  if (match && match[1] && emailOnly.test(match[1])) {
    return v;
  }

  return null;
}

function canUseResend() {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = normalizeEmailAddress(process.env.RESEND_FROM_EMAIL);
  return !!key && !!from;
}

async function forwardContactMessageByResend(payload) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const fromEmail = normalizeEmailAddress(process.env.RESEND_FROM_EMAIL);
  if (!apiKey || !fromEmail) {
    return {
      sent: false,
      reason: 'resend_not_configured',
      errorMessage: !apiKey
        ? 'RESEND_API_KEY is missing'
        : 'RESEND_FROM_EMAIL is missing or invalid (use email@domain.com or Name <email@domain.com>)'
    };
  }

  const toEmail = await getBusinessSupportEmail();

  const subject = `New Contact Message - ${payload.subject || 'No Subject'}`;
  const text = [
    `Name: ${payload.full_name || '-'}`,
    `Email: ${payload.email || '-'}`,
    `Phone: ${payload.phone || '-'}`,
    `Source: ${payload.source_page || '-'}`,
    `Submitted At: ${new Date().toISOString()}`,
    '',
    `Subject: ${payload.subject || '-'}`,
    '',
    'Message:',
    payload.message || '-'
  ].join('\n');

  await httpJsonRequest({
    method: 'POST',
    hostname: 'api.resend.com',
    path: '/emails',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: {
      from: fromEmail,
      to: [toEmail],
      subject,
      text,
      replyTo: payload.email || undefined
    },
    timeoutMs: RESEND_REQUEST_TIMEOUT_MS
  });

  return { sent: true, recipient: toEmail, provider: 'resend' };
}

async function getBusinessSupportEmail() {
  try {
    const result = await db.query(
      `SELECT setting_value
       FROM site_settings
       WHERE setting_key = 'business_support_email'
       LIMIT 1`
    );
    const fromSettings = String(result.rows?.[0]?.setting_value || '').trim();
    return fromSettings || String(process.env.BUSINESS_SUPPORT_EMAIL || '').trim() || DEFAULT_SUPPORT_EMAIL;
  } catch (_) {
    return String(process.env.BUSINESS_SUPPORT_EMAIL || '').trim() || DEFAULT_SUPPORT_EMAIL;
  }
}

function createSmtpTransporter() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').trim();

  if (!smtpHost || !smtpUser || !smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: Number.isFinite(smtpPort) ? smtpPort : 587,
    secure: Number(smtpPort) === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass
    },
    connectionTimeout: Number.isFinite(SMTP_CONNECTION_TIMEOUT_MS) ? SMTP_CONNECTION_TIMEOUT_MS : 10000,
    greetingTimeout: Number.isFinite(SMTP_GREETING_TIMEOUT_MS) ? SMTP_GREETING_TIMEOUT_MS : 10000,
    socketTimeout: Number.isFinite(SMTP_SOCKET_TIMEOUT_MS) ? SMTP_SOCKET_TIMEOUT_MS : 15000
  });
}

async function forwardContactMessageByEmail(payload) {
  // Prefer HTTPS-based provider when configured (avoids SMTP network blocks/timeouts).
  if (canUseResend()) {
    return await withTimeout(
      forwardContactMessageByResend(payload),
      CONTACT_EMAIL_FORWARD_TIMEOUT_MS,
      'Resend send'
    );
  }

  const transporter = createSmtpTransporter();
  if (!transporter) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const toEmail = await getBusinessSupportEmail();
  const fromEmail = String(process.env.SMTP_FROM_EMAIL || '').trim() || String(process.env.SMTP_USER || '').trim();

  const subject = `New Contact Message - ${payload.subject || 'No Subject'}`;
  const text = [
    `Name: ${payload.full_name || '-'}`,
    `Email: ${payload.email || '-'}`,
    `Phone: ${payload.phone || '-'}`,
    `Source: ${payload.source_page || '-'}`,
    `Submitted At: ${new Date().toISOString()}`,
    '',
    `Subject: ${payload.subject || '-'}`,
    '',
    'Message:',
    payload.message || '-'
  ].join('\n');

  await withTimeout(
    transporter.sendMail({
      from: fromEmail,
      to: toEmail,
      replyTo: payload.email || undefined,
      subject,
      text
    }),
    CONTACT_EMAIL_FORWARD_TIMEOUT_MS,
    'SMTP send'
  );

  return { sent: true, recipient: toEmail };
}

router.post('/', optionalAuth, async (req, res) => {
  try {
    const {
      full_name,
      email,
      phone = null,
      subject = null,
      message,
      source_page = 'home'
    } = req.body || {};

    const messageType = 'message';

    const safeName = String(full_name || '').trim();
    const safeEmail = String(email || '').trim();
    const safePhone = phone == null ? null : String(phone).trim();
    const safeSubject = subject == null ? null : String(subject).trim();
    const safeMessage = String(message || '').trim();
    const safeSource = String(source_page || '').trim().slice(0, 50) || 'home';

    if (!safeName) {
      return res.status(400).json({ error: 'Full name is required.' });
    }

    if (!safeEmail) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    if (!safeMessage) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    if (safeMessage.length > 4000) {
      return res.status(400).json({ error: 'Message is too long.' });
    }

    const userId = req.user?.id || null;

    const insertQuery = `
      INSERT INTO contact_messages (
        user_id,
        message_type,
        full_name,
        email,
        phone,
        subject,
        message,
        source_page
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, created_at
    `;

    const result = await db.query(insertQuery, [
      userId,
      messageType,
      safeName,
      safeEmail,
      safePhone,
      safeSubject,
      safeMessage,
      safeSource
    ]);

    // Respond immediately so the customer UI doesn't hang if SMTP is slow/blocked.
    // Email forwarding happens in the background and is recorded on the message row.
    res.status(201).json({
      message: 'Sent successfully.',
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      email_forwarded: false,
      forwarded_to: null
    });

    const messageId = result.rows[0].id;
    setImmediate(async () => {
      let emailForward = { sent: false, reason: null, recipient: null, errorMessage: null };
      try {
        emailForward = await forwardContactMessageByEmail({
          full_name: safeName,
          email: safeEmail,
          phone: safePhone,
          subject: safeSubject,
          message: safeMessage,
          source_page: safeSource
        });
      } catch (mailErr) {
        console.error('Contact email forward error:', mailErr);
        emailForward = {
          sent: false,
          reason: 'send_failed',
          recipient: null,
          errorMessage: String(mailErr?.message || 'Email send failed')
        };
      }

      const forwardError = emailForward.sent
        ? null
        : String(emailForward.errorMessage || emailForward.reason || 'not_forwarded');

      try {
        await db.query(
          `
            UPDATE contact_messages
            SET
              email_forwarded = $1,
              email_forwarded_at = $2,
              forwarded_to = $3,
              email_forward_error = $4
            WHERE id = $5
          `,
          [
            !!emailForward.sent,
            emailForward.sent ? new Date().toISOString() : null,
            emailForward.recipient || null,
            forwardError,
            messageId
          ]
        );
      } catch (updateErr) {
        console.error('Contact email forward status update error:', updateErr);
      }
    });
  } catch (error) {
    console.error('Contact submit error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

module.exports = router;
