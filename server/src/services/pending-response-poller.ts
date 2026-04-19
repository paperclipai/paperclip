import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pendingResponseService } from "./pending-responses.js";
import { heartbeatService } from "./heartbeat.js";

const POLL_INTERVAL_MS = 30_000;
const SLACK_API_BASE = "https://slack.com/api";

interface SlackRepliesResponse {
  ok: boolean;
  messages?: Array<{ ts: string; text: string; user?: string }>;
  error?: string;
}

async function fetchSlackReplies(
  channelId: string,
  threadTs: string,
  token: string,
): Promise<SlackRepliesResponse> {
  const url = `${SLACK_API_BASE}/conversations.replies?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(threadTs)}&limit=10`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.json() as Promise<SlackRepliesResponse>;
}

export function createPendingResponsePoller(db: Db) {
  const svc = pendingResponseService(db);
  const heartbeat = heartbeatService(db);
  const log = logger.child({ component: "pending-response-poller" });

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      log.warn("SLACK_BOT_TOKEN not set — skipping pending response poll");
      return;
    }

    const now = new Date();
    let rows: Awaited<ReturnType<typeof svc.listActivePending>>;
    try {
      rows = await svc.listActivePending(now);
    } catch (err) {
      log.error({ err }, "Failed to list active pending responses");
      return;
    }

    if (rows.length === 0) return;

    log.debug({ count: rows.length }, "Polling Slack threads for pending responses");

    for (const row of rows) {
      try {
        const result = await fetchSlackReplies(row.channelId, row.threadTs, slackToken);

        if (!result.ok) {
          log.warn({ channelId: row.channelId, threadTs: row.threadTs, error: result.error }, "Slack API error");
          continue;
        }

        const messages = result.messages ?? [];
        // First message is the original; replies are indices 1+
        if (messages.length <= 1) continue;

        const reply = messages[messages.length - 1]!;

        await heartbeat.wakeup(row.waitingAgentId, {
          source: "automation",
          triggerDetail: "callback",
          reason: "Slack thread reply received",
          payload: {
            source: "pending_response",
            pendingResponseId: row.id,
            threadTs: row.threadTs,
            channelId: row.channelId,
            reply: { ts: reply.ts, text: reply.text, user: reply.user },
          },
          requestedByActorType: "system",
        });

        await svc.markFulfilled(row.id);
        log.info({ pendingResponseId: row.id, agentId: row.waitingAgentId }, "Pending response fulfilled");
      } catch (err) {
        log.error({ err, pendingResponseId: row.id }, "Error processing pending response row");
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    timer.unref();
    log.info({ pollIntervalMs: POLL_INTERVAL_MS }, "Pending response poller started");
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
    log.info("Pending response poller stopped");
  }

  return { start, stop };
}
