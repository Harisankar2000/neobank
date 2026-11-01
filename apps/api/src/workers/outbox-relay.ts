import { withTransaction } from '../db/pool.js';

export interface OutboxMessage {
  key: string;
  value: string;
}

/** Anything that can send messages: Kafka in production, an array in tests. */
export interface Publisher {
  publish(messages: OutboxMessage[]): Promise<void>;
}

export interface BankEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * Publishes one batch of unpublished outbox rows, oldest first.
 *
 * FOR UPDATE SKIP LOCKED lets several relays run side by side: each one takes
 * rows nobody else has locked, so no event is sent by two relays at once.
 *
 * Delivery is "at least once": if we crash after Kafka accepted the batch but
 * before the UPDATE commits, the batch is sent again. Consumers handle that by
 * ignoring an eventId they have already processed.
 */
export async function relayBatch(publisher: Publisher, batchSize = 100): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: number;
      eventId: string;
      eventType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      createdAt: Date;
    }>(
      `SELECT id, event_id AS "eventId", event_type AS "eventType", aggregate_id AS "aggregateId", payload,
              created_at AS "createdAt"
         FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) return 0;

    const ids = rows.map((row) => row.id);
    try {
      await publisher.publish(
        rows.map((row) => ({
          // Same key → same Kafka partition → events of one transaction stay in order.
          key: row.aggregateId,
          value: JSON.stringify({
            eventId: row.eventId,
            type: row.eventType,
            occurredAt: row.createdAt.toISOString(),
            payload: row.payload,
          } satisfies BankEvent),
        })),
      );
    } catch (error) {
      // Kafka is down: keep the rows unpublished and try again on the next tick.
      await client.query(
        `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])`,
        [ids, (error as Error).message.slice(0, 500)],
      );
      return 0;
    }

    await client.query(`UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
    return rows.length;
  });
}
