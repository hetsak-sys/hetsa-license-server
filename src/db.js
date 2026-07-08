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

  // Fast lookup for "does this device already own an activated license" —
  // this is what makes /api/verify's paid-status check cheap.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_licenses_activated_device
      ON licenses(activated_device_id)
      WHERE activated_device_id IS NOT NULL;
  `);
}
