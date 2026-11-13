import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { DecisionNotifier, type NotifierOptions } from "../src/notifier.js";

// Synthetic identifiers only.
export const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
export const OTHER_COMPANY_ID = "00000000-0000-4000-8000-000000000002";
export const ISSUE_ID = "00000000-0000-4000-8000-0000000000a1";
export const PRIVATE_ISSUE_ID = "00000000-0000-4000-8000-0000000000a2";
export const APPROVAL_ID = "00000000-0000-4000-8000-0000000000b1";
export const INTERACTION_ID = "00000000-0000-4000-8000-0000000000c1";
export const AGENT_ID = "00000000-0000-4000-8000-0000000000d1";
export const USER_ID = "user-example-1";
export const SECRET_ID = "00000000-0000-4000-8000-0000000000e1";
export const TOKEN = "tk_synthetic_token_value";
export const SECRET_TITLE = "Confidential launch plan for Project Nightingale";

export const BASE_CONFIG = {
  ntfyBaseUrl: "https://ntfy.example.test",
  topic: "decisions",
  tokenSecretRef: { type: "secret_ref", secretId: SECRET_ID },
  paperclipBaseUrl: "https://paperclip.example.test",
};

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchBehaviour = (attempt: number, request: CapturedRequest, signal?: AbortSignal | null) => Promise<Response>;

export function okResponse(): Promise<Response> {
  return Promise.resolve(new Response("{}", { status: 200 }));
}

export interface Setup {
  harness: TestHarness;
  notifier: DecisionNotifier;
  requests: CapturedRequest[];
  makeNotifier: (options?: Partial<NotifierOptions>) => DecisionNotifier;
}

export function setup(options: {
  config?: Record<string, unknown>;
  fetch?: FetchBehaviour;
  notifier?: Partial<NotifierOptions>;
} = {}): Setup {
  const harness = createTestHarness({ manifest, config: options.config ?? BASE_CONFIG });
  harness.ctx.secrets.resolve = async (ref: unknown) => {
    const secretId = (ref as { secretId?: string }).secretId;
    if (secretId !== SECRET_ID) throw new Error(`unknown secret ${secretId}`);
    return TOKEN;
  };
  harness.seed({
    companies: [{ id: COMPANY_ID, name: "Example Co", issuePrefix: "EX" } as never],
    issues: [
      {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        identifier: "EX-42",
        title: SECRET_TITLE,
        status: "in_progress",
      } as never,
    ],
  });
  const requests: CapturedRequest[] = [];
  const behaviour = options.fetch ?? (() => okResponse());
  const fetch = async (url: string, init?: RequestInit) => {
    const request: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body ?? ""),
    };
    requests.push(request);
    return behaviour(requests.length, request, init?.signal);
  };
  const makeNotifier = (overrides: Partial<NotifierOptions> = {}) =>
    new DecisionNotifier(harness.ctx, {
      timeoutMs: 50,
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => {},
      fetch,
      ...options.notifier,
      ...overrides,
    });
  return { harness, notifier: makeNotifier(), requests, makeNotifier };
}

let counter = 0;
export function event(eventType: string, partial: Partial<PluginEvent> & { payload: unknown }): PluginEvent {
  counter += 1;
  return {
    eventId: `evt-${counter}`,
    eventType: eventType as PluginEvent["eventType"],
    occurredAt: new Date(0).toISOString(),
    companyId: COMPANY_ID,
    actorType: "agent",
    actorId: AGENT_ID,
    ...partial,
  };
}

export function approvalCreated(issueIds: string[] = [ISSUE_ID], approvalId = APPROVAL_ID): PluginEvent {
  return event("approval.created", {
    entityType: "approval",
    entityId: approvalId,
    payload: { type: "request_board_approval", issueIds, agentId: AGENT_ID, runId: null, responsibleUserId: USER_ID },
  });
}

export function interactionCreated(details: Record<string, unknown> = {}, issueId = ISSUE_ID): PluginEvent {
  return event("issue.thread_interaction_created", {
    entityType: "issue",
    entityId: issueId,
    payload: {
      interactionId: INTERACTION_ID,
      interactionKind: "ask_user_questions",
      interactionStatus: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: null,
      addresseeUserId: USER_ID,
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      title: SECRET_TITLE,
      agentId: AGENT_ID,
      runId: null,
      responsibleUserId: USER_ID,
      ...details,
    },
  });
}

export function issueUpdated(payload: Record<string, unknown>, issueId = ISSUE_ID): PluginEvent {
  return event("issue.updated", { entityType: "issue", entityId: issueId, payload });
}
