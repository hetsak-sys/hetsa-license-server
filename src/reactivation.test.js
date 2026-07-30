import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSwapEligibility, formatRetryDate, buildLockoutMessage, REACTIVATION_POLICY } from './reactivation.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('evaluateSwapEligibility', () => {
  test('no prior swaps — allowed, 0 used, 2 remaining', () => {
    const r = evaluateSwapEligibility([], NOW);
    assert.equal(r.allowed, true);
    assert.equal(r.swapsUsed, 0);
    assert.equal(r.swapsRemaining, 2);
    assert.equal(r.retryAt, null);
  });

  test('one swap within the window — still allowed, 1 remaining', () => {
    const r = evaluateSwapEligibility([daysAgo(5)], NOW);
    assert.equal(r.allowed, true);
    assert.equal(r.swapsUsed, 1);
    assert.equal(r.swapsRemaining, 1);
  });

  test('two swaps within the window — blocked, 0 remaining', () => {
    const r = evaluateSwapEligibility([daysAgo(20), daysAgo(5)], NOW);
    assert.equal(r.allowed, false);
    assert.equal(r.swapsUsed, 2);
    assert.equal(r.swapsRemaining, 0);
    assert.ok(r.retryAt instanceof Date);
  });

  test('retryAt is exactly cooldownDays after the OLDEST counted swap, not the newest', () => {
    const r = evaluateSwapEligibility([daysAgo(20), daysAgo(5)], NOW);
    // oldest swap was 20 days ago -> frees up at day 30-20=10 days from now
    const expected = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    assert.equal(r.retryAt.toISOString().slice(0, 10), expected.toISOString().slice(0, 10));
  });

  test('a swap exactly at the 30-day boundary (not strictly within) does not count', () => {
    const exactlyThirty = new Date(NOW.getTime() - REACTIVATION_POLICY.cooldownDays * 24 * 60 * 60 * 1000).toISOString();
    const r = evaluateSwapEligibility([exactlyThirty], NOW);
    assert.equal(r.swapsUsed, 0);
    assert.equal(r.allowed, true);
  });

  test('a swap just inside the 30-day boundary does count', () => {
    const justInside = new Date(NOW.getTime() - (REACTIVATION_POLICY.cooldownDays * 24 * 60 * 60 * 1000 - 1000)).toISOString();
    const r = evaluateSwapEligibility([justInside], NOW);
    assert.equal(r.swapsUsed, 1);
  });

  test('swaps older than the window are ignored entirely, even with several of them', () => {
    const r = evaluateSwapEligibility([daysAgo(40), daysAgo(35), daysAgo(31)], NOW);
    assert.equal(r.swapsUsed, 0);
    assert.equal(r.allowed, true);
  });

  test('mixed: old swaps outside window plus one inside — only the in-window one counts', () => {
    const r = evaluateSwapEligibility([daysAgo(40), daysAgo(10)], NOW);
    assert.equal(r.swapsUsed, 1);
    assert.equal(r.allowed, true);
  });

  test('accepts Date objects as well as ISO strings, identically', () => {
    const asString = evaluateSwapEligibility([daysAgo(5)], NOW);
    const asDate = evaluateSwapEligibility([new Date(daysAgo(5))], NOW);
    assert.deepEqual(asString.swapsUsed, asDate.swapsUsed);
  });

  test('a malformed timestamp is silently ignored rather than throwing or crashing the count', () => {
    const r = evaluateSwapEligibility(['not-a-date', daysAgo(5)], NOW);
    assert.equal(r.swapsUsed, 1);
  });

  test('empty/undefined input is treated as no swaps, not a throw', () => {
    assert.doesNotThrow(() => evaluateSwapEligibility(undefined, NOW));
    assert.equal(evaluateSwapEligibility(undefined, NOW).allowed, true);
  });
});

describe('formatRetryDate', () => {
  test('formats as YYYY-MM-DD in UTC, matching TIMESTAMPTZ storage convention', () => {
    assert.equal(formatRetryDate(new Date('2026-08-15T23:59:00.000Z')), '2026-08-15');
  });
});

describe('buildLockoutMessage', () => {
  test('states the retry date and the support email, exact wording per locked spec', () => {
    const msg = buildLockoutMessage(new Date('2026-08-15T00:00:00.000Z'));
    assert.match(msg, /2026-08-15/);
    assert.match(msg, /hetsak@gmail\.com/);
  });
});

describe('REACTIVATION_POLICY', () => {
  test('matches the locked spec exactly: 2 swaps per rolling 30 days', () => {
    assert.equal(REACTIVATION_POLICY.maxSwapsPerWindow, 2);
    assert.equal(REACTIVATION_POLICY.cooldownDays, 30);
  });
});
