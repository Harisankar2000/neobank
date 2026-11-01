import { pool } from '../db/pool.js';
import { formatInr } from '../lib/money.js';
import type { BankEvent } from './outbox-relay.js';

export interface NotificationDraft {
  customerId: string;
  title: string;
  body: string;
}

interface TransferPayload {
  reference: string;
  amount: number;
  fromCustomerId: string | null;
  fromName: string;
  fromAccountNumber: string;
  toCustomerId: string | null;
  toName: string;
  toAccountNumber: string;
  failureReason: string | null;
  reason?: string;
}

const last4 = (accountNumber: string) => `XX${accountNumber.slice(-4)}`;

/** Pure function: which customers to tell, and what to say, for one event. */
export function buildNotifications(event: Pick<BankEvent, 'type' | 'payload'>): NotificationDraft[] {
  if (event.type === 'account.status_changed') {
    const p = event.payload as { customerId: string; accountNumber: string; status: string; reason: string };
    return [
      {
        customerId: p.customerId,
        title: p.status === 'FROZEN' ? 'Account frozen' : 'Account active again',
        body: `Account ${last4(p.accountNumber)} is now ${p.status.toLowerCase()}. ${p.reason}`,
      },
    ];
  }

  const p = event.payload as unknown as TransferPayload;
  const amount = formatInr(p.amount);
  const sameCustomer = p.fromCustomerId === p.toCustomerId;

  switch (event.type) {
    case 'deposit.completed':
      return p.toCustomerId
        ? [{ customerId: p.toCustomerId, title: 'Money added', body: `${amount} credited to ${last4(p.toAccountNumber)}.` }]
        : [];

    case 'transfer.completed':
      if (sameCustomer && p.fromCustomerId) {
        return [
          {
            customerId: p.fromCustomerId,
            title: 'Moved between your accounts',
            body: `${amount} from ${last4(p.fromAccountNumber)} to ${last4(p.toAccountNumber)}. Ref ${p.reference}`,
          },
        ];
      }
      return [
        p.fromCustomerId && {
          customerId: p.fromCustomerId,
          title: 'Money sent',
          body: `${amount} sent to ${p.toName}. Ref ${p.reference}`,
        },
        p.toCustomerId && {
          customerId: p.toCustomerId,
          title: 'Money received',
          body: `${amount} received from ${p.fromName}. Ref ${p.reference}`,
        },
      ].filter((n): n is NotificationDraft => Boolean(n));

    case 'transfer.pending_review':
      return p.fromCustomerId
        ? [
            {
              customerId: p.fromCustomerId,
              title: 'Transfer under review',
              body: `Your transfer of ${amount} to ${p.toName} is being checked. The money is held safely meanwhile.`,
            },
          ]
        : [];

    case 'transfer.failed':
      return p.fromCustomerId
        ? [
            {
              customerId: p.fromCustomerId,
              title: 'Transfer failed',
              body: `Your transfer of ${amount} to ${p.toName} did not go through (${p.failureReason ?? 'unknown reason'}).`,
            },
          ]
        : [];

    case 'transfer.reversed':
      return [
        p.fromCustomerId && {
          customerId: p.fromCustomerId,
          title: 'Transfer reversed',
          body: `${amount} sent to ${p.toName} was returned to you. Ref ${p.reference}`,
        },
        p.toCustomerId &&
          !sameCustomer && {
            customerId: p.toCustomerId,
            title: 'Credit reversed',
            body: `${amount} received from ${p.fromName} was reversed by the bank. Ref ${p.reference}`,
          },
      ].filter((n): n is NotificationDraft => Boolean(n));

    default:
      return [];
  }
}

/**
 * Kafka may deliver a message more than once. The UNIQUE (event_id,
 * customer_id) constraint plus ON CONFLICT DO NOTHING makes a repeat harmless:
 * this is an idempotent consumer.
 */
export async function handleBankEvent(event: BankEvent): Promise<number> {
  let inserted = 0;
  for (const draft of buildNotifications(event)) {
    // created_at is when the event happened, not when it arrived: Kafka keeps
    // order only within a partition, so events can arrive out of order.
    const result = await pool.query(
      `INSERT INTO notifications (event_id, customer_id, title, body, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, customer_id) DO NOTHING`,
      [event.eventId, draft.customerId, draft.title, draft.body, event.occurredAt],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
