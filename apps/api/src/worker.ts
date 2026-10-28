/**
 * Background process: publishes the outbox to Kafka and consumes Kafka to
 * build customer notifications. Runs separately from the API, so a slow or
 * broken Kafka never slows down payments.
 */
import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { handleBankEvent } from './workers/notifier.js';
import { relayBatch, type BankEvent } from './workers/outbox-relay.js';

const kafka = new Kafka({ clientId: 'neobank-worker', brokers: env.KAFKA_BROKERS, logLevel: logLevel.WARN });
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner, idempotent: true });
const consumer = kafka.consumer({ groupId: 'neobank-notifier' });

let running = true;

async function relayLoop() {
  while (running) {
    try {
      const sent = await relayBatch({
        publish: async (messages) => {
          await producer.send({ topic: env.KAFKA_TOPIC, messages });
        },
      });
      if (sent > 0) console.log(`relay: published ${sent} event(s)`);
      // A full batch probably means more are waiting: go again without sleeping.
      if (sent === 100) continue;
    } catch (error) {
      console.error('relay error', error);
    }
    await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
  }
}

async function main() {
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: env.KAFKA_TOPIC, numPartitions: 3, replicationFactor: 1 }] });
  await admin.disconnect();

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: env.KAFKA_TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString()) as BankEvent;
      const created = await handleBankEvent(event);
      if (created > 0) console.log(`notifier: ${event.type} → ${created} notification(s)`);
    },
  });

  console.log(`worker running: outbox → Kafka topic "${env.KAFKA_TOPIC}" → notifications`);
  await relayLoop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    running = false;
    await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
    await pool.end();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('worker failed to start', error);
  process.exit(1);
});
