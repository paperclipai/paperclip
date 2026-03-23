import { Queue, Worker, type Processor, RedisConnection } from "bullmq";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const QUEUE_NAMES = {
  APPROVE_TIMER: "approve-timer",
  DIGEST:        "digest",
  BUDGET_WATCH:  "budget-watch",
} as const;

let connection: RedisConnection | null = null;

export function getRedisConnection(): RedisConnection {
  if (!connection) {
    connection = new RedisConnection({ connection: { url: REDIS_URL, maxRetriesPerRequest: null } });
  }
  return connection;
}

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: getRedisConnection() as any }));
  }
  return queues.get(name)!;
}

export function createWorker(name: string, processor: Processor): Worker {
  return new Worker(name, processor, { connection: getRedisConnection() as any });
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all([...queues.values()].map(q => q.close()));
  await connection?.disconnect();
}
