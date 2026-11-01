import { createHash } from 'node:crypto';
import type { DbClient } from '../db/pool.js';
import { ConflictError } from '../lib/errors.js';

export interface IdempotentResponse {
  statusCode: number;
  body: unknown;
  /** True when this is a stored answer to an earlier request with the same key. */
  replayed: boolean;
}

/** Fingerprint of the request body, so a key cannot be reused for a different request. */
export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * Runs `work` at most once per (scope, key). Call it inside withTransaction():
 * the key is stored in the SAME database transaction as the money movement,
 * so either both are saved or neither is.
 *
 * Two identical requests at the same moment: the second INSERT waits on the
 * primary key until the first commits, then finds the row and replays the
 * stored response. Exactly one of them moves money.
 */
export async function runIdempotent(
  client: DbClient,
  scope: string,
  key: string,
  requestHash: string,
  work: () => Promise<{ statusCode: number; body: unknown }>,
): Promise<IdempotentResponse> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING key`,
    [scope, key, requestHash],
  );

  if (inserted.rowCount === 0) {
    const { rows } = await client.query<{ requestHash: string; statusCode: number; body: unknown }>(
      `SELECT request_hash AS "requestHash", response_status AS "statusCode", response_body AS body
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const stored = rows[0]!;
    if (stored.requestHash !== requestHash) {
      throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    return { statusCode: stored.statusCode, body: stored.body, replayed: true };
  }

  const result = await work();
  // Store exactly what JSON serialisation produces, so a replay is byte-for-byte the same.
  const body = JSON.parse(JSON.stringify(result.body)) as unknown;
  await client.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2`,
    [scope, key, result.statusCode, JSON.stringify(body)],
  );
  return { statusCode: result.statusCode, body, replayed: false };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
