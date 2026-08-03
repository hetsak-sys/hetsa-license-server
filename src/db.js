import pg from 'pg';

const { Pool } = pg;

// Render's managed Postgres requires SSL. Render's own certs aren't in
// Node's default trust store, so we disable strict verification the same
// way Render's own docs and most guides for this platform do. This is the
// standard tradeoff for connecting to Render Postgres from a Render web
// service — it's still an encrypted connection, just not verifying the
// certificate chain. Locally (no DATABASE_URL, or a localhost one) we skip
// SSL entirely so `npm run dev` works against a local Postgres.
const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

export const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// Runs on server startup. Uses IF NOT EXISTS everywhere so it's safe to run
// on every boot — no separate migration step to remember, which matters
// for a solo-maintained project on a free-tier host.
export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id     TEXT PRIMARY KEY,
      trial_start   TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      license_key         TEXT PRIMARY KEY,
      status               TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'activated')),
      activated_device_id TEXT REFERENCES devices(device_id),
      activated_at         TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Added 2026-07-30 for self-service reactivation (Option B). Existing rows
  // default to 'standard' with no backfill needed — ADD COLUMN IF NOT EXISTS
  // keeps this safe to run on every boot alongside the CREATE TABLEs above.
  // Institutional seats are flagged at generation time (generate-keys.js
  // --institutional) and are checked by /api/reactivate to stay manual-only,
  // per the locked spec.
  await pool.query(`
    ALTER TABLE licenses
      ADD COLUMN IF NOT EXISTS license_type TEXT NOT NULL DEFAULT 'standard'
        CHECK (license_type IN ('standard', 'institutional'));
  `);

  // Added 2026-07-30 for self-service reactivation (Option B). One row per
  // completed device swap; /api/reactivate counts rows in the trailing
  // 30-day window (see src/reactivation.js) to enforce the 2-per-30-days
  // cooldown. Append-only audit trail — never updated or deleted, so it
  // also doubles as a support/dispute record if a key's swap history is
  // ever questioned.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_swaps (
      id            BIGSERIAL PRIMARY KEY,
      license_key   TEXT NOT NULL REFERENCES licenses(license_key),
      old_device_id TEXT,
      new_device_id TEXT NOT NULL,
      swapped_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Powers the rolling-window count in /api/reactivate — one query, indexed
  // lookup, rather than a full table scan per reactivation attempt.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_device_swaps_license_key_swapped_at
      ON device_swaps(license_key, swapped_at);
  `);

  // Fast lookup for "does this device already own an activated license" —
  // this is what makes /api/verify's paid-status check cheap.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_licenses_activated_device
      ON licenses(activated_device_id)
      WHERE activated_device_id IS NOT NULL;
  `);

  // Added 2026-08-03 for the in-app Suggestion Box. Standalone table, no
  // foreign keys to devices/licenses — feedback is accepted from any
  // device, licensed or trial, so it's deliberately not joined to the
  // licensing schema. `emailed` tracks whether the Gmail notification in
  // feedbackRoute.js succeeded; a failed email never blocks the DB write,
  // so this flag is the fallback way to find any notification that
  // silently failed (SELECT * FROM feedback WHERE emailed = false).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id           SERIAL PRIMARY KEY,
      message      TEXT NOT NULL,
      contact      TEXT,
      device_id    TEXT,
      app_version  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      emailed      BOOLEAN NOT NULL DEFAULT false
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at DESC);
  `);
}
