import { Kafka, logLevel, Partitioners, type KafkaConfig } from 'kafkajs';
import { env } from '../config/env.js';
import { handleBankEvent } from './notifier.js';
import { relayBatch, type BankEvent, type Publisher } from './outbox-relay.js';

export interface WorkerLogger {
  info(message: string): void;
  error(error: unknown, message?: string): void;
}

export interface BackgroundWorker {
  stop(): Promise<void>;
}

const consoleLogger: WorkerLogger = {
  info: (message) => console.log(message),
  error: (error, message) => console.error(message ?? 'worker error', error),
};

/**
 * Starts the outbox relay and the notifier.
 *
 * - kafka:  relay → Kafka topic → consumer group → notifier (the full design)
 * - direct: relay → notifier in this process. Same outbox, same at-least-once
 *           delivery and idempotent consumer; only the transport differs. Used
 *           where no Kafka cluster is available, such as free hosting tiers.
 */
export async function startBackgroundWorker(log: WorkerLogger = consoleLogger): Promise<BackgroundWorker> {
  let publisher: Publisher;
  let disconnect = async () => {};

  if (env.EVENT_TRANSPORT === 'direct') {
    publisher = {
      publish: async (messages) => {
        for (const message of messages) {
          const event = JSON.parse(message.value) as BankEvent;
          const created = await handleBankEvent(event);
          if (created > 0) log.info(`notifier: ${event.type} → ${created} notification(s)`);
        }
      },
    };
    log.info('worker running: outbox → notifications (direct mode, no Kafka)');
  } else {
    const kafka = new Kafka(kafkaConfig());
    await ensureTopic(kafka, log);

    const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner, idempotent: true });
    const consumer = kafka.consumer({ groupId: 'neobank-notifier' });
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: env.KAFKA_TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString()) as BankEvent;
        const created = await handleBankEvent(event);
        if (created > 0) log.info(`notifier: ${event.type} → ${created} notification(s)`);
      },
    });

    publisher = {
      publish: async (messages) => {
        await producer.send({ topic: env.KAFKA_TOPIC, messages });
      },
    };
    disconnect = async () => {
      await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
    };
    log.info(`worker running: outbox → Kafka topic "${env.KAFKA_TOPIC}" → notifications`);
  }

  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const sent = await relayBatch(publisher);
        if (sent > 0) log.info(`relay: published ${sent} event(s)`);
        // A full batch probably means more are waiting: go again without sleeping.
        if (sent === 100) continue;
      } catch (error) {
        log.error(error, 'relay error');
      }
      await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
    }
  })();

  return {
    stop: async () => {
      running = false;
      await loop;
      await disconnect();
    },
  };
}

function kafkaConfig(): KafkaConfig {
  const ssl =
    env.KAFKA_SSL_CA || env.KAFKA_SSL_CERT
      ? { ca: env.KAFKA_SSL_CA ? [env.KAFKA_SSL_CA] : undefined, cert: env.KAFKA_SSL_CERT, key: env.KAFKA_SSL_KEY }
      : env.KAFKA_SSL || undefined;
  const sasl =
    env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD
      ? { mechanism: env.KAFKA_SASL_MECHANISM, username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD }
      : undefined;
  return { clientId: 'neobank-worker', brokers: env.KAFKA_BROKERS, logLevel: logLevel.WARN, ssl, sasl } as KafkaConfig;
}

/** Creates the topic if missing. Managed clusters may forbid this; then create it in their console. */
async function ensureTopic(kafka: Kafka, log: WorkerLogger): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: [
        {
          topic: env.KAFKA_TOPIC,
          numPartitions: env.KAFKA_TOPIC_PARTITIONS,
          replicationFactor: env.KAFKA_TOPIC_REPLICATION,
        },
      ],
    });
  } catch (error) {
    log.error(error, `could not create topic "${env.KAFKA_TOPIC}"; create it in your Kafka console if it is missing`);
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
