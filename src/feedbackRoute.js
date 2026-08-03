import dns from 'dns';
import express from 'express';
import nodemailer from 'nodemailer';
import { pool } from './db.js';

// Fix for ENETUNREACH connecting to Gmail's SMTP servers on Render: Node
// resolves smtp.gmail.com's IPv6 address first by default, but Render's
// outbound network can't route IPv6, and Node doesn't automatically fall
// back to IPv4 on that failure. Forcing IPv4-first DNS resolution process-
// wide fixes this. (Node 18+; see https://nodejs.org/api/dns.html#dnssetdefaultresultorderorder)
dns.setDefaultResultOrder('ipv4first');

const router = express.Router();

// Requires two Render environment variables (set in the dashboard, never
// committed): GMAIL_USER (hetsak@gmail.com) and GMAIL_APP_PASSWORD (a
// 16-char Gmail App Password, generated at
// https://myaccount.google.com/apppasswords — requires 2-Step Verification
// enabled on the account first). NOT the real Gmail account password.
//
// host/port/secure are specified explicitly (rather than the `service:
// 'gmail'` shorthand) so `family: 4` can be passed through to force the
// underlying socket connection over IPv4 — belt-and-suspenders alongside
// the dns.setDefaultResultOrder() call above.
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const MAX_MESSAGE_LENGTH = 4000;

/**
 * POST /api/feedback { message, contact?, deviceId?, appVersion? }
 * In-app Suggestion Box. Accepted from any device (licensed, trial, or
 * unregistered) — this is deliberately not gated by license status.
 * The DB write is the source of truth; the email is best-effort and its
 * failure must never fail the request or lose the message.
 */
router.post('/api/feedback', async (req, res) => {
  const { message, contact, deviceId, appVersion } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ message: 'Message is required.' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ message: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }

  let insertedId;
  try {
    const result = await pool.query(
      `INSERT INTO feedback (message, contact, device_id, app_version)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [message.trim(), contact || null, deviceId || null, appVersion || null]
    );
    insertedId = result.rows[0].id;
  } catch (err) {
    console.error('feedback insert error:', err);
    // Fail closed on the DB write — if we can't save it, don't claim success.
    return res.status(500).json({ message: 'Could not save your suggestion. Please try again.' });
  }

  // Email is best-effort. A failed email must never fail the request or
  // lose the message — it's already safe in the database regardless of
  // what happens below.
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: 'hetsak@gmail.com',
      subject: `Hetsa PowerSuite — new suggestion (#${insertedId})`,
      text: [
        'New suggestion box message received.',
        '',
        'Message:',
        message.trim(),
        '',
        `Contact: ${contact || '(none given)'}`,
        `Device ID: ${deviceId || '(none)'}`,
        `App version: ${appVersion || '(unknown)'}`,
        `Feedback ID: ${insertedId}`,
      ].join('\n'),
    });
    await pool.query('UPDATE feedback SET emailed = true WHERE id = $1', [insertedId]);
  } catch (err) {
    console.error(`feedback email notification failed for id ${insertedId}:`, err);
    // Not fatal — message is safe in the DB even if this step fails. The
    // `emailed = false` flag is the fallback: SELECT * FROM feedback WHERE
    // emailed = false finds anything that needs a manual check.
  }

  return res.status(200).json({ received: true, id: insertedId });
});

export default router;
