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

interface ActiveSubscriptionState {
  kind: "active";
  timer: NodeJS.Timeout;
  lastSignature: string;
}

interface PendingSubscriptionState {
  kind: "pending";
  promise: Promise<void>;
}

type SubscriptionState = ActiveSubscriptionState | PendingSubscriptionState;

export interface HeartbeatRunSubscriptionOptions {
  server: McpServer;
  readSnapshot: (uri: string) => Promise<HeartbeatRunSnapshot | null>;
  onError?: (error: unknown, context: { uri: string }) => void;
}

function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === "string" && status !== "queued" && status !== "running";
}

function snapshotSignature(snapshot: HeartbeatRunSnapshot): string {
  // Resource-update notifications only signal clients to refetch log content;
  // status and byte-count changes are the observable inputs for that resource.
  return JSON.stringify({
    status: snapshot.status ?? null,
    logBytes: snapshot.logBytes ?? 0,
  });
}

function reportSubscriptionError(options: HeartbeatRunSubscriptionOptions, uri: string, error: unknown) {
  if (options.onError) {
    options.onError(error, { uri });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("Heartbeat run resource subscription stopped", { uri, error: message });
}

export function createHeartbeatRunSubscriptions(options: HeartbeatRunSubscriptionOptions) {
  const subscriptions = new Map<string, SubscriptionState>();

  const unsubscribe = (uri: string) => {
    const existing = subscriptions.get(uri);
    if (!existing) return;
    if (existing.kind === "active") clearInterval(existing.timer);
    subscriptions.delete(uri);
  };

  const subscribe = async (uri: string) => {
    const existing = subscriptions.get(uri);
    if (existing) {
      if (existing.kind === "pending") await existing.promise;
      return;
    }

    const pending: PendingSubscriptionState = {
      kind: "pending",
      promise: Promise.resolve(),
    };

    pending.promise = (async () => {
      try {
        const snapshot = await options.readSnapshot(uri);
        if (!snapshot) throw new Error(`Unsupported heartbeat run resource URI: ${uri}`);
        if (subscriptions.get(uri) !== pending) return;
        if (isTerminalRunStatus(snapshot.status)) {
          subscriptions.delete(uri);
          return;
        }

        const state: ActiveSubscriptionState = {
          kind: "active",
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
                  await options.server.server.sendResourceUpdated({ uri });
                  state.lastSignature = nextSignature;
                }
                if (isTerminalRunStatus(next.status)) unsubscribe(uri);
              } catch (error) {
                reportSubscriptionError(options, uri, error);
                unsubscribe(uri);
              }
            })();
          }, SUBSCRIPTION_POLL_MS),
        };
        state.timer.unref?.();
        subscriptions.set(uri, state);
      } catch (error) {
        if (subscriptions.get(uri) === pending) subscriptions.delete(uri);
        throw error;
      }
    })();

    subscriptions.set(uri, pending);
    await pending.promise;
  };

  const close = () => {
    for (const uri of [...subscriptions.keys()]) unsubscribe(uri);
  };

  return { subscribe, unsubscribe, close };
}
