import { z } from 'zod';

/** Amounts are integer paise: ₹250.50 is 25050. */
export const paise = (maxRupees: number) =>
  z.number().int('Amount must be whole paise').positive().max(maxRupees * 100, `At most ₹${maxRupees.toLocaleString('en-IN')}`);

export const idParam = z.object({ id: z.uuid() });

export const idempotencyHeaders = z.object({
  'idempotency-key': z.string().min(8).max(100),
});

export const accountNumber = z.string().regex(/^5010\d{8}$/, 'A NeoBank account number is 5010 followed by 8 digits');

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
