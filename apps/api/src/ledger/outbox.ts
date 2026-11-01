import type { DbClient } from '../db/pool.js';

export type EventType =
  | 'deposit.completed'
  | 'transfer.completed'
  | 'transfer.pending_review'
  | 'transfer.failed'
  | 'transfer.reversed'
  | 'account.status_changed';

/**
 * Writes an event to the outbox table inside the caller's transaction.
 * If the transaction rolls back, the event disappears with it; if it commits,
 * the relay is guaranteed to find it and publish it to Kafka.
 */
export async function enqueueEvent(
  client: DbClient,
  eventType: EventType,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(`INSERT INTO outbox_events (event_type, aggregate_id, payload) VALUES ($1, $2, $3)`, [
    eventType,
    aggregateId,
    JSON.stringify(payload),
  ]);
}
