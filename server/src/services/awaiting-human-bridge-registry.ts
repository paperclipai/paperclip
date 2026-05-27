import type { Db } from "@paperclipai/db";
import type { AwaitingHumanNotificationPayload } from "./awaiting-human-notifications.js";

export type AwaitingHumanBridgePollEvent = {
  kind: "reply" | "approval_signal" | "reject_signal";
  externalEventId?: string | null;
  externalThreadId?: string | null;
  externalMessageId?: string | null;
  body?: string | null;
  raw?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type AwaitingHumanBridgeAdapter = {
  send(input: {
    bridgeId: string;
    companyId: string;
    issueId: string;
    interactionId: string;
    agentId: string;
    handoffKind: "request_confirmation" | "ask_user_questions";
    notification: AwaitingHumanNotificationPayload;
    externalThreadId?: string | null;
  }): Promise<{
    externalThreadId: string | null;
    externalMessageId?: string | null;
    nextPollAt?: Date | null;
  }>;
  poll(input: {
    bridgeId: string;
    externalThreadId?: string | null;
    externalMessageId?: string | null;
  }): Promise<{
    status: "ok" | "skipped" | "failed";
    detail: string;
    events: AwaitingHumanBridgePollEvent[];
  }>;
  close(input: {
    bridgeId: string;
    externalThreadId?: string | null;
    externalMessageId?: string | null;
    outcome?: string | null;
    reason?: string | null;
  }): Promise<void>;
};

const registry = new Map<string, (db: Db) => AwaitingHumanBridgeAdapter>();

export function registerAwaitingHumanBridgeAdapter(
  type: string,
  factory: (db: Db) => AwaitingHumanBridgeAdapter,
): void {
  registry.set(type, factory);
}

export function hasAwaitingHumanBridgeAdapter(type: string): boolean {
  return registry.has(type);
}

export function hasAnyAwaitingHumanBridgeAdapter(): boolean {
  return registry.size > 0;
}

export function resolveAwaitingHumanBridgeAdapter(
  type: string,
  db: Db,
): AwaitingHumanBridgeAdapter {
  const factory = registry.get(type);
  if (!factory) throw new Error(`Unknown awaiting human bridge provider: ${type}`);
  return factory(db);
}
