/**
 * Event Router Service — Postgres LISTEN/NOTIFY based event-driven wake system.
 *
 * Replaces 80% of cron-based heartbeats with event-driven precise wakes.
 * Uses a single persistent DB connection with LISTEN to receive notifications
 * from Postgres triggers on issues, issue_comments, and agents tables.
 *
 * Key design decisions:
 * - Single connection: avoids connection pool exhaustion
 * - In-memory routing: fast event dispatch without DB round-trips
 * - Durable replay: uses activity_log.event_processed for crash recovery
 * - Compact payload: {event_type, entity_id, txid}
 *
 * Note: The postgres library handles reconnection automatically.
 * If the connection is lost, calling sql() again will establish a new connection.
 */

import { EventEmitter } from "node:events";
import postgres from "postgres";
import { logger } from "../middleware/logger.js";

export interface EventPayload {
  event_type: string;
  entity_id: string;
  txid: string;
}

export interface RoutedEvent {
  payload: EventPayload;
  receivedAt: Date;
}

type EventHandler = (event: RoutedEvent) => Promise<void> | void;

const EVENT_CHANNEL = "paperclip_events";
const REPLAY_MINUTES = 60;
const PROCESSING_BATCH_SIZE = 100;

class EventRouterService extends EventEmitter {
  private sql: postgres.Sql | null = null;
  private shutdownFlag = false;
  private handlers = new Map<string, Set<EventHandler>>();
  private processedTxids = new Set<string>();
  private connectionString: string | null = null;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  async start(connectionString: string): Promise<void> {
    if (this.sql) {
      logger.warn("Event router already started");
      return;
    }

    this.connectionString = connectionString;
    this.shutdownFlag = false;

    try {
      await this.connect();
      await this.replayUnprocessedEvents();
      logger.info("Event router started");
    } catch (err) {
      logger.error({ err }, "Failed to start event router");
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.shutdownFlag = true;

    if (this.sql) {
      try {
        await this.sql.end();
        logger.info("Event router stopped");
      } catch (err) {
        logger.error({ err }, "Error stopping event router");
      }
      this.sql = null;
    }
  }

  onEvent(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  offEvent(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  private async connect(): Promise<void> {
    if (!this.connectionString) {
      throw new Error("No connection string configured");
    }

    this.sql = postgres(this.connectionString, {
      max: 1,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });

    this.sql.listen(EVENT_CHANNEL, (payload: string) => {
      this.handleNotification(payload).catch((err) => {
        logger.error({ err }, "Error handling notification");
      });
    }, () => {
      logger.debug("Successfully subscribed to paperclip_events channel");
    });
  }

  private async handleNotification(payload: string): Promise<void> {
    let parsed: EventPayload;
    try {
      parsed = JSON.parse(payload) as EventPayload;
    } catch {
      logger.warn({ payload }, "Invalid event payload, skipping");
      return;
    }

    if (!parsed.event_type || !parsed.entity_id) {
      logger.warn({ parsed }, "Malformed event payload, skipping");
      return;
    }

    if (this.processedTxids.has(parsed.txid)) {
      return;
    }
    this.processedTxids.add(parsed.txid);

    if (this.processedTxids.size > 10000) {
      const entries = Array.from(this.processedTxids);
      this.processedTxids = new Set(entries.slice(-5000));
    }

    const event: RoutedEvent = {
      payload: parsed,
      receivedAt: new Date(),
    };

    logger.debug({ event_type: parsed.event_type, entity_id: parsed.entity_id }, "Event received");

    const handlers = this.handlers.get(parsed.event_type);
    if (handlers && handlers.size > 0) {
      const promises = Array.from(handlers).map((handler) =>
        Promise.resolve(handler(event)).catch((err) => {
          logger.error({ err, event_type: parsed.event_type }, "Event handler error");
        }),
      );
      await Promise.all(promises);
    }

    this.emit("event", event);
  }

  private async replayUnprocessedEvents(): Promise<void> {
    if (!this.sql) return;

    try {
      const events = await this.sql.unsafe<Array<{
        id: string;
        event_type: string;
        entity_id: string;
        txid: string;
        created_at: Date;
      }>>(`
        SELECT id, action AS event_type, entity_id,
               (details->>'txid')::text AS txid, created_at
        FROM activity_log
        WHERE event_processed = false
          AND created_at >= NOW() - INTERVAL '${REPLAY_MINUTES} minutes'
          AND action IN ('issue_created', 'issue_updated', 'issue_comment_created', 'agent_updated')
        ORDER BY created_at ASC
        LIMIT ${PROCESSING_BATCH_SIZE}
      `);

      if (!events || events.length === 0) {
        logger.debug("No unprocessed events to replay");
        return;
      }

      logger.info({ count: events.length }, "Replaying unprocessed events from activity_log");

      const toMarkProcessed: string[] = [];

      for (const row of events) {
        const event: RoutedEvent = {
          payload: {
            event_type: row.event_type,
            entity_id: row.entity_id,
            txid: row.txid,
          },
          receivedAt: new Date(),
        };

        if (this.processedTxids.has(row.txid)) {
          toMarkProcessed.push(row.id);
          continue;
        }
        this.processedTxids.add(row.txid);

        const handlers = this.handlers.get(row.event_type);
        if (handlers && handlers.size > 0) {
          for (const handler of handlers) {
            try {
              await handler(event);
            } catch (err) {
              logger.error({ err, event_type: row.event_type }, "Replay event handler error");
            }
          }
        }

        toMarkProcessed.push(row.id);
        this.emit("event", event);
      }

      if (toMarkProcessed.length > 0) {
        await this.sql.unsafe(`
          UPDATE activity_log
          SET event_processed = true
          WHERE id = ANY($1)
        `, [toMarkProcessed]);
        logger.debug({ marked: toMarkProcessed.length }, "Marked replayed events as processed");
      }
    } catch (err) {
      logger.error({ err }, "Error replaying unprocessed events");
    }
  }
}

let eventRouterInstance: EventRouterService | null = null;

export function getEventRouter(): EventRouterService {
  if (!eventRouterInstance) {
    eventRouterInstance = new EventRouterService();
  }
  return eventRouterInstance;
}

export async function startEventRouter(connectionString: string): Promise<void> {
  const router = getEventRouter();
  await router.start(connectionString);
}

export async function stopEventRouter(): Promise<void> {
  if (eventRouterInstance) {
    await eventRouterInstance.stop();
    eventRouterInstance = null;
  }
}
