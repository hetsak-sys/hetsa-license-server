// Run with: npm run generate-keys -- 10
// (generates 10 new unused keys and prints + inserts them)
import 'dotenv/config';
import { pool, ensureSchema } from '../src/db.js';
import { generateLicenseKey } from '../src/licenseKey.js';

const count = parseInt(process.argv[2], 10) || 10;

async function main() {
  await ensureSchema();
  const keys = [];

  for (let i = 0; i < count; i++) {
    // Regenerate on the rare collision (astronomically unlikely at this
    // charset/length, but cheap to guard against).
    let key;
    for (let attempt = 0; attempt < 5; attempt++) {
      key = generateLicenseKey();
      const existing = await pool.query('SELECT 1 FROM licenses WHERE license_key = $1', [key]);
      if (existing.rowCount === 0) break;
      key = null;
    }
    if (!key) {
      throw new Error('Could not generate a unique key after 5 attempts — very unusual, check the charset/length.');
    }
    await pool.query('INSERT INTO licenses (license_key) VALUES ($1)', [key]);
    keys.push(key);
  }

  console.log(`Generated ${keys.length} new license key(s):\n`);
  keys.forEach(k => console.log(k));

  await pool.end();
}

main().catch((err) => {
  console.error('Key generation failed:', err);
  process.exit(1);
});
