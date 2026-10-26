import type { Redis } from 'ioredis';
import type { Paise } from '../lib/money.js';

/**
 * Suspicious-activity rules. A transfer that matches any rule is not refused:
 * it is held as PENDING and an admin approves or rejects it.
 */
export const RISK_LIMITS = {
  /** Any single transfer at or above ₹50,000. */
  largeAmount: 50_000_00,
  /** Sending ₹10,000 or more to a payee added in the last 24 hours. */
  newBeneficiaryAmount: 10_000_00,
  newBeneficiaryHours: 24,
  /** More than 5 transfer attempts by one customer within 10 minutes. */
  velocityMaxAttempts: 5,
  velocityWindowSeconds: 600,
} as const;

export type RiskReason = 'LARGE_AMOUNT' | 'NEW_BENEFICIARY' | 'HIGH_VELOCITY';

export interface RiskInput {
  amount: Paise;
  beneficiaryAddedAt: Date;
  /** Attempts in the current window, including this one. */
  recentAttempts: number;
  now?: Date;
}

/** Pure function: same input, same answer. Easy to unit test. */
export function evaluateTransferRisk(input: RiskInput): RiskReason[] {
  const { amount, beneficiaryAddedAt, recentAttempts, now = new Date() } = input;
  const reasons: RiskReason[] = [];

  if (amount >= RISK_LIMITS.largeAmount) reasons.push('LARGE_AMOUNT');

  const beneficiaryAgeHours = (now.getTime() - beneficiaryAddedAt.getTime()) / 3_600_000;
  if (beneficiaryAgeHours < RISK_LIMITS.newBeneficiaryHours && amount >= RISK_LIMITS.newBeneficiaryAmount) {
    reasons.push('NEW_BENEFICIARY');
  }

  if (recentAttempts > RISK_LIMITS.velocityMaxAttempts) reasons.push('HIGH_VELOCITY');

  return reasons;
}

/**
 * Counts transfer attempts per customer in fixed 10-minute windows using Redis
 * INCR. Redis is shared by every API instance and expires old windows itself.
 * If Redis is down we return 0 (fail open): a broken counter should not stop
 * all payments, and the other rules and limits still apply.
 */
export async function recordTransferAttempt(redis: Redis, customerId: string, now = Date.now()): Promise<number> {
  const window = Math.floor(now / 1000 / RISK_LIMITS.velocityWindowSeconds);
  const key = `neobank:velocity:${customerId}:${window}`;
  try {
    const [[, count]] = (await redis.multi().incr(key).expire(key, RISK_LIMITS.velocityWindowSeconds).exec()) as [
      [Error | null, number],
    ];
    return count;
  } catch {
    return 0;
  }
}
