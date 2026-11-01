import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/lib/redis.js';
import { buildNotifications, handleBankEvent } from '../src/workers/notifier.js';
import { relayBatch, type BankEvent, type OutboxMessage } from '../src/workers/outbox-relay.js';
import { addPayee, createCustomer, resetDatabase, send } from './helpers.js';

beforeEach(resetDatabase);
afterAll(async () => {
  await Promise.all([pool.end(), redis.quit()]);
});

describe('outbox relay', () => {
  it('publishes each event once and marks it published', async () => {
    const asha = await createCustomer('Asha', 1_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    await send(asha, rahul, 100);

    const sent: OutboxMessage[] = [];
    const publisher = { publish: async (messages: OutboxMessage[]) => void sent.push(...messages) };

    expect(await relayBatch(publisher)).toBe(2); // deposit.completed + transfer.completed
    expect(await relayBatch(publisher)).toBe(0);
    expect(sent.map((m) => (JSON.parse(m.value) as BankEvent).type)).toEqual(['deposit.completed', 'transfer.completed']);
  });

  it('keeps events when Kafka is down, and sends them once it is back', async () => {
    await createCustomer('Asha', 1_000);

    const down = { publish: async () => Promise.reject(new Error('broker unavailable')) };
    expect(await relayBatch(down)).toBe(0);
    const { rows } = await pool.query(`SELECT attempts, last_error, published_at FROM outbox_events`);
    expect(rows).toEqual([{ attempts: 1, last_error: 'broker unavailable', published_at: null }]);

    const up = { publish: async () => {} };
    expect(await relayBatch(up)).toBe(1);
  });
});

describe('notifier', () => {
  it('ignores a redelivered event (idempotent consumer)', async () => {
    const asha = await createCustomer('Asha', 1_000);
    const rahul = await createCustomer('Rahul');
    await addPayee(asha, rahul);
    await send(asha, rahul, 100);

    const events: BankEvent[] = [];
    await relayBatch({ publish: async (messages) => void events.push(...messages.map((m) => JSON.parse(m.value) as BankEvent)) });

    for (const event of events) await handleBankEvent(event);
    for (const event of events) await handleBankEvent(event); // Kafka redelivers

    const { rows } = await pool.query(`SELECT title FROM notifications ORDER BY created_at, id`);
    expect(rows.map((r) => r.title)).toEqual(['Money added', 'Money sent', 'Money received']);
  });

  it('sends one message for a move between the customer’s own accounts', () => {
    const drafts = buildNotifications({
      type: 'transfer.completed',
      payload: {
        reference: 'NB1',
        amount: 150000,
        fromCustomerId: 'c1',
        toCustomerId: 'c1',
        fromName: 'Asha',
        toName: 'Asha',
        fromAccountNumber: '501000000001',
        toAccountNumber: '501000000002',
      },
    });
    expect(drafts).toEqual([
      { customerId: 'c1', title: 'Moved between your accounts', body: expect.stringContaining('₹1,500.00') },
    ]);
  });
});
