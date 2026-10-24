-- NeoBank schema.
-- All money is bigint paise (₹1 = 100). Account balances are a cached total of entries.

CREATE TABLE customers (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      text        NOT NULL,
  email          text        NOT NULL UNIQUE,
  phone          text        NOT NULL UNIQUE,
  password_hash  text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Account numbers look like 5010 0000 0001: a fixed bank prefix plus a sequence.
CREATE SEQUENCE account_number_seq START 1;

-- CUSTOMER accounts belong to a person. SYSTEM accounts belong to the bank:
--   BANK-CASH-INR          money entering or leaving the bank (deposits)
--   TRANSFER-SUSPENSE-INR  money parked while a flagged transfer waits for review
CREATE TABLE accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid        REFERENCES customers (id),
  account_number  text        NOT NULL UNIQUE,
  kind            text        NOT NULL CHECK (kind IN ('CUSTOMER', 'SYSTEM')),
  product         text        NOT NULL CHECK (product IN ('SAVINGS', 'CURRENT', 'SYSTEM')),
  currency        char(3)     NOT NULL DEFAULT 'INR',
  balance         bigint      NOT NULL DEFAULT 0,
  -- Maximum total of outgoing transfers per calendar day (IST).
  daily_limit     bigint      NOT NULL DEFAULT 10000000 CHECK (daily_limit > 0),
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_owner CHECK ((kind = 'CUSTOMER') = (customer_id IS NOT NULL)),
  -- Last line of defence: a customer balance can never go below zero.
  CONSTRAINT accounts_no_overdraft CHECK (kind = 'SYSTEM' OR balance >= 0)
);
CREATE INDEX accounts_customer_idx ON accounts (customer_id);

-- One row per money movement, with its lifecycle:
--   PENDING   flagged by a risk rule; money is held in suspense until reviewed
--   COMPLETED money has reached the destination
--   FAILED    rejected (insufficient funds, limit, review rejected); no money moved, or it was returned
--   REVERSED  completed earlier, then undone by a separate REVERSAL transaction
CREATE TABLE transactions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text        NOT NULL UNIQUE,
  type             text        NOT NULL CHECK (type IN ('DEPOSIT', 'TRANSFER', 'REVERSAL')),
  status           text        NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED')),
  amount           bigint      NOT NULL CHECK (amount > 0),
  currency         char(3)     NOT NULL DEFAULT 'INR',
  from_account_id  uuid        NOT NULL REFERENCES accounts (id),
  to_account_id    uuid        NOT NULL REFERENCES accounts (id),
  initiated_by     uuid        REFERENCES customers (id),
  description      text,
  failure_reason   text,
  risk_reasons     text[]      NOT NULL DEFAULT '{}',
  reverses_id      uuid        UNIQUE REFERENCES transactions (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT transactions_distinct_accounts CHECK (from_account_id <> to_account_id)
);
CREATE INDEX transactions_from_idx ON transactions (from_account_id, created_at DESC);
CREATE INDEX transactions_to_idx ON transactions (to_account_id, created_at DESC);
CREATE INDEX transactions_pending_idx ON transactions (created_at) WHERE status = 'PENDING';

-- The journal. Every step of a transaction writes one DEBIT (money out) and one
-- CREDIT (money in) of the same amount. Rows are never changed or deleted.
CREATE TABLE entries (
  id              bigserial   PRIMARY KEY,
  transaction_id  uuid        NOT NULL REFERENCES transactions (id),
  account_id      uuid        NOT NULL REFERENCES accounts (id),
  direction       text        NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount          bigint      NOT NULL CHECK (amount > 0),
  balance_after   bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_account_idx ON entries (account_id, id);
CREATE INDEX entries_transaction_idx ON entries (transaction_id);

-- Shared guard for tables that must never change once written.
CREATE FUNCTION block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Rule 1: the journal is append-only. Mistakes are fixed with a REVERSAL.
CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION block_changes();

-- Rule 2: for every transaction, total debits = total credits.
-- DEFERRABLE INITIALLY DEFERRED means it is checked at COMMIT, after both
-- entries are written, so a half-written transfer can never be saved.
CREATE FUNCTION entries_check_balanced() RETURNS trigger AS $$
DECLARE
  difference bigint;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
    INTO difference
    FROM entries
   WHERE transaction_id = NEW.transaction_id;

  IF difference <> 0 THEN
    RAISE EXCEPTION 'transaction % is unbalanced: credits minus debits = %', NEW.transaction_id, difference;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION entries_check_balanced();

-- Saved payees. A customer may only transfer to their own accounts or to these.
CREATE TABLE beneficiaries (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid        NOT NULL REFERENCES customers (id),
  account_id   uuid        NOT NULL REFERENCES accounts (id),
  nickname     text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, account_id)
);

-- Stored responses for money-moving requests. A retried request with the same
-- key gets the stored response back instead of moving money twice.
CREATE TABLE idempotency_keys (
  scope            text        NOT NULL,
  key              text        NOT NULL,
  request_hash     text        NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Transactional outbox: events are written in the same DB transaction as the
-- money movement, then a relay publishes them to Kafka.
CREATE TABLE outbox_events (
  id            bigserial   PRIMARY KEY,
  event_id      uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_type    text        NOT NULL,
  aggregate_id  uuid        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int         NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

-- In-app notifications built by the Kafka consumer. event_id makes a
-- redelivered Kafka message harmless.
CREATE TABLE notifications (
  id           bigserial   PRIMARY KEY,
  event_id     uuid        NOT NULL,
  customer_id  uuid        NOT NULL REFERENCES customers (id),
  title        text        NOT NULL,
  body         text        NOT NULL,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, customer_id)
);
CREATE INDEX notifications_customer_idx ON notifications (customer_id, id DESC);

-- Who did what, when. Append-only like the journal.
CREATE TABLE audit_logs (
  id           bigserial   PRIMARY KEY,
  actor_type   text        NOT NULL CHECK (actor_type IN ('CUSTOMER', 'ADMIN', 'SYSTEM')),
  actor_id     text,
  action       text        NOT NULL,
  entity_type  text        NOT NULL,
  entity_id    text,
  details      jsonb       NOT NULL DEFAULT '{}',
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (id DESC);

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_changes();

CREATE TABLE reconciliation_runs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text        NOT NULL CHECK (status IN ('BALANCED', 'MISMATCH')),
  checks      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO accounts (account_number, kind, product)
VALUES ('BANK-CASH-INR', 'SYSTEM', 'SYSTEM'),
       ('TRANSFER-SUSPENSE-INR', 'SYSTEM', 'SYSTEM');
