import { vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

export type FakeCall = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
};

export type FakeHandler = (call: FakeCall) => Response | Promise<Response>;

export const BASE = "https://api.qoder.com/api/v1/cloud";
export const SESSION_ID = "sess_new";
export const AGENT_ID = "agent_managed";
export const ENV_ID = "env_default";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function apiError(status: number, type: string, message: string): Response {
  return json({ type: "error", request_id: "req-1", error: { type, message } }, status);
}

export function sseBody(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `${event.id ? `id: ${event.id}\n` : ""}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

export function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(sseBody(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Stays open until the request is aborted, like a live turn that never finishes. */
export function hangingSse(signal: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: heartbeat\ndata: {}\n\n"));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export const END_TURN = { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "end_turn" } };
export const DEFAULT_TURN = [
  { id: "evt_running", type: "session.status_running" },
  { id: "evt_thinking", type: "agent.thinking" },
  { id: "evt_msg", type: "agent.message", content: [{ type: "text", text: "Done\nWith detail" }] },
  END_TURN,
];

export function createFakeQoder(overrides: Record<string, FakeHandler | FakeHandler[]> = {}) {
  const calls: FakeCall[] = [];
  const defaults: Record<string, FakeHandler> = {
    "GET /environments": () => json({
      data: [
        { id: "env_self_hosted", type: "environment", config: { type: "self_hosted" } },
        { id: "env_archived", type: "environment", config: { type: "cloud" }, archived_at: "2026-01-01T00:00:00Z" },
        { id: ENV_ID, type: "environment", config: { type: "cloud" } },
      ],
    }),
    "POST /environments": () => json({ id: "env_created", type: "environment" }),
    "POST /agents/search": () => json({ data: [] }),
    "POST /agents": () => json({ id: AGENT_ID, type: "agent", version: 1 }),
    "POST /sessions": () => json({ id: SESSION_ID, type: "session", status: "idle" }),
    "GET /sessions/:id": () => json({
      id: SESSION_ID,
      type: "session",
      status: "idle",
      archived_at: null,
      usage: { model_credits: 1.5, sandbox_runtime_credits: 0.25, total_credits: 1.75 },
    }),
    "POST /sessions/:id/events": () => json({ data: [{ id: "evt_user", type: "user.message" }] }),
    "GET /sessions/:id/events/stream": () => sse(DEFAULT_TURN),
    "POST /sessions/:id/cancel": () => json({ id: SESSION_ID, type: "session", status: "canceling" }, 202),
  };
  const counters = new Map<string, number>();

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.startsWith(BASE)) throw new Error(`Unexpected Qoder URL: ${url}`);
    const [rawPath] = url.slice(BASE.length).split("?");
    const method = init?.method ?? "GET";
    const call: FakeCall = {
      method,
      path: url.slice(BASE.length),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    call.signal?.throwIfAborted();
    const key = `${method} ${rawPath.replace(/\/(sess|agent)_[^/]+/, "/:id")}`;
    const handler = overrides[key] ?? defaults[key];
    if (!handler) throw new Error(`No fake Qoder handler for ${key}`);
    if (Array.isArray(handler)) {
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      return handler[Math.min(index, handler.length - 1)](call);
    }
    return handler(call);
  };

  return {
    fetchImpl,
    calls,
    find: (method: string, pathPrefix: string) =>
      calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix)),
  };
}

export function createContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext & {
  logs: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
  meta: Record<string, unknown>[];
} {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const meta: Record<string, unknown>[] = [];
  const base: AdapterExecutionContext = {
    runId: "run-heartbeat-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Qoder Agent",
      adapterType: "qoder_cloud_agents",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      env: {
        QODER_ACCESS_TOKEN: "pt-secret",
        QODER_REPO_TOKEN: "ghp_repo_secret",
        EXTRA_FLAG: "1",
      },
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoStartingRef: "main",
      promptTemplate: "Do the work for {{agent.name}}",
    },
    context: {
      taskId: "issue-1",
      issueId: "issue-1",
      wakeReason: "issue_commented",
    },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (entry) => {
      meta.push(entry as unknown as Record<string, unknown>);
    },
  };
  const ctx = { ...base, ...overrides, logs, meta };
  // Paperclip hands adapters the saved agent config alongside the resolved one;
  // tests mutate ctx.config after creation, so keep both pointing at the same object.
  ctx.agent = { ...ctx.agent, adapterConfig: ctx.config };
  return ctx;
}

export function stdoutEvents(ctx: { logs: Array<{ stream: string; chunk: string }> }): Array<Record<string, unknown>> {
  return ctx.logs
    .filter((entry) => entry.stream === "stdout")
    .map((entry) => JSON.parse(entry.chunk) as Record<string, unknown>);
}

export function sentPrompt(qoder: ReturnType<typeof createFakeQoder>, index = 0): string {
  const body = qoder.find("POST", `/sessions/${SESSION_ID}/events`)[index]?.body as
    | { events: Array<{ content: Array<{ text: string }> }> }
    | undefined;
  return String(body?.events[0]?.content[0]?.text);
}

/** Runs once to mint the session params a later heartbeat would be handed back. */
export async function storedSessionParams(ctx: AdapterExecutionContext): Promise<Record<string, unknown>> {
  const result = await execute(createContext({ config: ctx.config, agent: ctx.agent }), {
    fetchImpl: createFakeQoder().fetchImpl,
  });
  return result.sessionParams as Record<string, unknown>;
}

export const noSleep = vi.fn(async () => {});
