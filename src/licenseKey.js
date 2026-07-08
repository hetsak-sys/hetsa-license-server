import crypto from 'crypto';

// Excludes O, 0, I, 1 — visually ambiguous characters that cause customer
// entry errors when read off a screen or a printed receipt.
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// HETSA-XXXX-XXXX-XXXX, groups drawn from CHARSET only.
const KEY_PATTERN = /^HETSA-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

function randomGroup(length) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

export function generateLicenseKey() {
  return `HETSA-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

export function isValidKeyFormat(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}
