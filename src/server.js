import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pool, ensureSchema } from './db.js';
import { isValidKeyFormat } from './licenseKey.js';
import { evaluateSwapEligibility, buildLockoutMessage } from './reactivation.js';
import feedbackRoute from './feedbackRoute.js';

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

app.use(feedbackRoute);

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

/**
 * POST /api/reactivate { deviceId, licenseKey }
 * Self-service device swap (Option B, approved 2026-07-29). `deviceId` here
 * is the NEW device requesting the move — the old device is read off the
 * license row itself, so the user only ever needs to enter their key on
 * the new device, nothing about the old one.
 *
 * Distinct from /api/license/activate: activate already handles same-device
 * reinstalls idempotently and 409s on a genuine cross-device conflict. This
 * endpoint is what the client calls *after* hitting that 409, to actually
 * move the key — bounded by the cooldown below.
 *
 * Rules (per the locked spec):
 * - Institutional keys are manual-only — always rejected here, directed to
 *   support instead. There is deliberately no self-service path for those.
 * - Trial devices never reach this endpoint at all: a trial has no
 *   license_key to pass in (trial state lives only in `devices.trial_start`,
 *   never in `licenses`), so "trial keys get 0 swaps" from the spec is
 *   already true by construction — nothing further to enforce here.
 * - A key not yet activated has nothing to move — points the caller at
 *   /api/license/activate instead.
 * - Same-device re-call is idempotent and does NOT consume a swap (matches
 *   /api/license/activate's reinstall-safe behavior — re-confirming an
 *   existing binding is not the same event as moving to a new device).
 * - Otherwise: 2 swaps per rolling 30 days per key, enforced via
 *   evaluateSwapEligibility() against the device_swaps audit table.
 */
app.post('/api/reactivate', async (req, res) => {
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

    const licenseRes = await client.query(
      `SELECT status, activated_device_id, license_type FROM licenses WHERE license_key = $1 FOR UPDATE`,
      [licenseKey]
    );

    if (licenseRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'License key not found. Check for typos and try again.' });
    }

    const license = licenseRes.rows[0];

    if (license.status !== 'activated') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This key has not been activated yet. Use Activate, not Reactivate.' });
    }

    if (license.license_type === 'institutional') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'Institutional licenses are managed manually — contact hetsak@gmail.com to move this seat to a new device.',
      });
    }

    // Same device asking again — idempotent, no swap consumed.
    if (license.activated_device_id === deviceId) {
      await client.query('ROLLBACK');
      return res.json({ reactivated: true, swapConsumed: false, message: 'License is already active on this device.' });
    }

    const swapRes = await client.query(
      `SELECT swapped_at FROM device_swaps
       WHERE license_key = $1 AND swapped_at > now() - interval '30 days'
       ORDER BY swapped_at ASC`,
      [licenseKey]
    );
    const eligibility = evaluateSwapEligibility(swapRes.rows.map((r) => r.swapped_at));

    if (!eligibility.allowed) {
      await client.query('ROLLBACK');
      return res.status(429).json({ message: buildLockoutMessage(eligibility.retryAt) });
    }

    const oldDeviceId = license.activated_device_id;

    // Ensure the new device has a row (harmless no-op if it already does —
    // e.g. it previously ran a trial on this same device before the swap).
    await client.query(
      `INSERT INTO devices (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`,
      [deviceId]
    );

    await client.query(
      `UPDATE licenses
       SET activated_device_id = $1, activated_at = now()
       WHERE license_key = $2`,
      [deviceId, licenseKey]
    );

    await client.query(
      `INSERT INTO device_swaps (license_key, old_device_id, new_device_id) VALUES ($1, $2, $3)`,
      [licenseKey, oldDeviceId, deviceId]
    );

    await client.query('COMMIT');

    const swapsUsedAfter = eligibility.swapsUsed + 1;
    return res.json({
      reactivated: true,
      swapConsumed: true,
      swapsRemaining: Math.max(0, 2 - swapsUsedAfter),
      message: 'License moved to this device.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reactivate error:', err);
    res.status(500).json({ message: 'Internal error reactivating license' });
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
