import { describe, expect, it } from 'vitest';
import { hashRequest } from '../src/ledger/idempotency.js';
import { generateReference } from '../src/ledger/ledger.js';
import { formatInr, startOfIstDay } from '../src/lib/money.js';
import { evaluateTransferRisk, RISK_LIMITS } from '../src/risk/rules.js';

const now = new Date('2026-10-25T10:00:00Z');
const oldPayee = new Date('2026-10-20T10:00:00Z');
const newPayee = new Date('2026-10-25T09:00:00Z');

describe('evaluateTransferRisk', () => {
  it('passes an ordinary transfer', () => {
    expect(evaluateTransferRisk({ amount: 5_000_00, beneficiaryAddedAt: oldPayee, recentAttempts: 1, now })).toEqual([]);
  });

  it('flags large amounts at the threshold', () => {
    const amount = RISK_LIMITS.largeAmount;
    expect(evaluateTransferRisk({ amount, beneficiaryAddedAt: oldPayee, recentAttempts: 1, now })).toEqual(['LARGE_AMOUNT']);
    expect(evaluateTransferRisk({ amount: amount - 1, beneficiaryAddedAt: oldPayee, recentAttempts: 1, now })).toEqual([]);
  });

  it('flags sizeable transfers to a payee added in the last 24 hours', () => {
    expect(evaluateTransferRisk({ amount: 10_000_00, beneficiaryAddedAt: newPayee, recentAttempts: 1, now })).toEqual([
      'NEW_BENEFICIARY',
    ]);
    expect(evaluateTransferRisk({ amount: 9_999_00, beneficiaryAddedAt: newPayee, recentAttempts: 1, now })).toEqual([]);
  });

  it('flags more than 5 attempts in the window, and can return several reasons', () => {
    expect(evaluateTransferRisk({ amount: 60_000_00, beneficiaryAddedAt: newPayee, recentAttempts: 6, now })).toEqual([
      'LARGE_AMOUNT',
      'NEW_BENEFICIARY',
      'HIGH_VELOCITY',
    ]);
  });
});

describe('money helpers', () => {
  it('formats paise as Indian rupees', () => {
    expect(formatInr(1_23_456_78)).toBe('₹1,23,456.78');
  });

  it('finds the start of the day in India', () => {
    // 25 Oct 01:00 IST is still 24 Oct 19:30 UTC.
    expect(startOfIstDay(new Date('2026-10-24T19:30:00Z')).toISOString()).toBe('2026-10-24T18:30:00.000Z');
    expect(startOfIstDay(new Date('2026-10-24T18:00:00Z')).toISOString()).toBe('2026-10-23T18:30:00.000Z');
  });
});

describe('idempotency fingerprint', () => {
  it('ignores key order but not values', () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ a: 1, b: 2 })).not.toBe(hashRequest({ a: 1, b: 3 }));
  });
});

describe('generateReference', () => {
  it('produces readable, unique references', () => {
    const ref = generateReference(now);
    expect(ref).toMatch(/^NB20261025[A-Z2-9]{8}$/);
    expect(new Set(Array.from({ length: 1000 }, () => generateReference())).size).toBe(1000);
  });
});
