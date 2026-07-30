// Run with: npm run generate-keys -- 10
// (generates 10 new unused standard keys and prints + inserts them)
// Add --institutional to generate institutional (manual-swap-only) seats:
//   npm run generate-keys -- 5 --institutional
import 'dotenv/config';
import { pool, ensureSchema } from '../src/db.js';
import { generateLicenseKey } from '../src/licenseKey.js';

const args = process.argv.slice(2);
const isInstitutional = args.includes('--institutional');
const countArg = args.find((a) => !a.startsWith('--'));
const count = parseInt(countArg, 10) || 10;
const licenseType = isInstitutional ? 'institutional' : 'standard';

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
    await pool.query('INSERT INTO licenses (license_key, license_type) VALUES ($1, $2)', [key, licenseType]);
    keys.push(key);
  }

  console.log(`Generated ${keys.length} new ${licenseType} license key(s):\n`);
  keys.forEach(k => console.log(k));
  if (isInstitutional) {
    console.log('\nNote: institutional keys are manual-swap-only — /api/reactivate will reject self-service moves for these; contact hetsak@gmail.com to move a seat.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Key generation failed:', err);
  process.exit(1);
});
