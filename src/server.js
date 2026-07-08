import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pool, ensureSchema } from './db.js';
import { isValidKeyFormat } from './licenseKey.js';

const TRIAL_DAYS = 90;
const PORT = process.env.PORT || 3000;

const app = express();

app.use(helmet());
// No cookies/sessions are involved — every request is authenticated purely
// by deviceId + licenseKey in the body — so a permissive CORS policy is
// safe here and lets you test the API from the Vite dev server in a
// browser as well as from the packaged Android app.
app.use(cors());
app.use(express.json());

// Generous limit: real traffic is a handful of requests per device per
// day (TTL-based revalidation on the client). This just guards against
// runaway loops or abuse, not normal usage.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
}));

function requireDeviceId(req, res, next) {
  const { deviceId } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ message: 'deviceId is required' });
  }
  next();
}

function daysLeftFrom(trialStart) {
  const elapsedMs = Date.now() - new Date(trialStart).getTime();
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
}

// Render (and any uptime monitor) can hit this without touching the DB.
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/verify { deviceId }
 * → { status: 'paid' | 'trial' | 'trial_expired' | 'not_registered', daysLeft }
 *
 * 'paid' takes priority: a device that activated a license is paid even if
 * it also has an old trial row (e.g. activated after the trial expired).
 */
app.post('/api/verify', requireDeviceId, async (req, res) => {
  const { deviceId } = req.body;
  try {
    const licenseRes = await pool.query(
      `SELECT license_key FROM licenses WHERE activated_device_id = $1 LIMIT 1`,
      [deviceId]
    );
    if (licenseRes.rowCount > 0) {
      return res.json({ status: 'paid', daysLeft: null });
    }

    const deviceRes = await pool.query(
      `SELECT trial_start FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    if (deviceRes.rowCount === 0) {
      return res.json({ status: 'not_registered', daysLeft: null });
    }

    const daysLeft = daysLeftFrom(deviceRes.rows[0].trial_start);
    return res.json({
      status: daysLeft > 0 ? 'trial' : 'trial_expired',
      daysLeft,
    });
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).json({ message: 'Internal error checking license status' });
  }
});

/**
 * POST /api/trial/register { deviceId }
 * Idempotent: safe to call repeatedly for the same device — the trial
 * clock only ever starts once, on first contact.
 */
app.post('/api/trial/register', requireDeviceId, async (req, res) => {
  const { deviceId } = req.body;
  try {
    await pool.query(
      `INSERT INTO devices (device_id) VALUES ($1)
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId]
    );
    res.json({ registered: true });
  } catch (err) {
    console.error('trial/register error:', err);
    res.status(500).json({ message: 'Internal error registering trial' });
  }
});

/**
 * POST /api/license/activate { deviceId, licenseKey }
 * Atomic: looks up the key and claims it for this device in a single
 * transaction, so two near-simultaneous activation attempts on the same
 * unused key can't both succeed.
 * Reinstall-safe: re-activating with a key already bound to THIS device
 * succeeds again (idempotent) rather than erroring, so a factory reset or
 * reinstall doesn't lock a legitimate paid user out.
 */
app.post('/api/license/activate', async (req, res) => {
  const { deviceId, licenseKey } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ message: 'deviceId is required' });
  }
  if (!isValidKeyFormat(licenseKey)) {
    return res.status(400).json({ message: 'License key format looks wrong. Expected HETSA-XXXX-XXXX-XXXX.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure the device row exists (a user might activate a key before
    // ever registering a trial — e.g. bought a key immediately). Harmless
    // no-op if it already exists.
    await client.query(
      `INSERT INTO devices (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`,
      [deviceId]
    );

    const licenseRes = await client.query(
      `SELECT status, activated_device_id FROM licenses WHERE license_key = $1 FOR UPDATE`,
      [licenseKey]
    );

    if (licenseRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'License key not found. Check for typos and try again.' });
    }

    const license = licenseRes.rows[0];

    if (license.status === 'activated' && license.activated_device_id !== deviceId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This license key is already activated on another device.' });
    }

    // Either it's unused, or it's already activated on THIS device
    // (reinstall/re-activation) — both cases resolve to the same update.
    await client.query(
      `UPDATE licenses
       SET status = 'activated', activated_device_id = $1, activated_at = now()
       WHERE license_key = $2`,
      [deviceId, licenseKey]
    );

    await client.query('COMMIT');
    return res.json({ activated: true, message: 'License activated successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('activate error:', err);
    res.status(500).json({ message: 'Internal error activating license' });
  } finally {
    client.release();
  }
});

async function start() {
  await ensureSchema();
  app.listen(PORT, () => {
    console.log(`hetsa-license-server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
