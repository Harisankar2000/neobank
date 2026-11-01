import type pg from 'pg';

export interface Actor {
  type: 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
  id?: string;
  ip?: string;
}

/**
 * Records who did what. Pass the transaction's client so the log line is
 * saved only if the action itself is saved.
 */
export async function audit(
  db: pg.Pool | pg.PoolClient,
  actor: Actor,
  action: string,
  entity: { type: string; id?: string },
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.type, actor.id ?? null, action, entity.type, entity.id ?? null, JSON.stringify(details), actor.ip ?? null],
  );
}
