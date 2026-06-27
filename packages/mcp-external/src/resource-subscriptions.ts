import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SUBSCRIPTION_POLL_MS = 1_000;

export interface HeartbeatRunSnapshot {
  status?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
  logBytes?: number | null;
  lastOutputSeq?: number | null;
  lastOutputAt?: string | null;
}

interface SubscriptionState {
  timer: NodeJS.Timeout;
  lastSignature: string;
}

export interface HeartbeatRunSubscriptionOptions {
  server: McpServer;
  readSnapshot: (uri: string) => Promise<HeartbeatRunSnapshot | null>;
}

function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === "string" && status !== "queued" && status !== "running";
}

function snapshotSignature(snapshot: HeartbeatRunSnapshot): string {
  return JSON.stringify({
    status: snapshot.status ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    finishedAt: snapshot.finishedAt ?? null,
    logBytes: snapshot.logBytes ?? 0,
    lastOutputSeq: snapshot.lastOutputSeq ?? null,
    lastOutputAt: snapshot.lastOutputAt ?? null,
  });
}

export function createHeartbeatRunSubscriptions(options: HeartbeatRunSubscriptionOptions) {
  const subscriptions = new Map<string, SubscriptionState>();

  const unsubscribe = (uri: string) => {
    const existing = subscriptions.get(uri);
    if (!existing) return;
    clearInterval(existing.timer);
    subscriptions.delete(uri);
  };

  const subscribe = async (uri: string) => {
    if (subscriptions.has(uri)) return;
    const snapshot = await options.readSnapshot(uri);
    if (!snapshot) throw new Error(`Unsupported heartbeat run resource URI: ${uri}`);
    const state: SubscriptionState = {
      lastSignature: snapshotSignature(snapshot),
      timer: setInterval(() => {
        void (async () => {
          try {
            const next = await options.readSnapshot(uri);
            if (!next) {
              unsubscribe(uri);
              return;
            }
            const nextSignature = snapshotSignature(next);
            if (nextSignature !== state.lastSignature) {
              state.lastSignature = nextSignature;
              await options.server.server.sendResourceUpdated({ uri });
            }
            if (isTerminalRunStatus(next.status)) unsubscribe(uri);
          } catch {
            unsubscribe(uri);
          }
        })();
      }, SUBSCRIPTION_POLL_MS),
    };
    state.timer.unref?.();
    subscriptions.set(uri, state);
    if (isTerminalRunStatus(snapshot.status)) unsubscribe(uri);
  };

  const close = () => {
    for (const uri of [...subscriptions.keys()]) unsubscribe(uri);
  };

  return { subscribe, unsubscribe, close };
}
