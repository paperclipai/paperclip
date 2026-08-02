/**
 * Synthetic fixtures for the Task Chat Redesign dev harness. No live agent is
 * required: every state in the inventory maps to a deterministic scenario the
 * harness renders and the finish-line test iterates. Tier-B states are driven
 * entirely from here (live protocol wiring is a flagged dependency).
 */
import type { TaskChatItem, TaskChatPlan } from "./task-chat-model";
import type { TaskChatStateId } from "./task-chat-states";

export interface TaskChatScenario {
  surface: "thread" | "plan";
  items: TaskChatItem[];
  plan?: TaskChatPlan;
}

const AGENT = "Atlas";

/** A short human→agent exchange used as context in several scenarios. */
function exchangePrefix(): TaskChatItem[] {
  return [
    { id: "m-user-1", kind: "message", author: "human", text: "Add a rate limiter to the login route.", timestamp: "2:31 PM" },
  ];
}

const SAMPLE_PLAN: TaskChatPlan = {
  revision: 2,
  updatedAt: "2:33 PM",
  entries: [
    { id: "p1", content: "Read the login route and existing middleware", status: "completed", priority: "medium" },
    { id: "p2", content: "Add a token-bucket rate limiter util", status: "in_progress", priority: "high" },
    { id: "p3", content: "Wire the limiter into POST /login", status: "pending", priority: "high" },
    { id: "p4", content: "Add tests for the limit + reset window", status: "pending", priority: "low" },
  ],
};

export function buildScenario(id: TaskChatStateId): TaskChatScenario {
  switch (id) {
    case "session-start":
      return {
        surface: "thread",
        items: [
          { id: "mk-start", kind: "marker", variant: "session_start", label: "Session started", detail: "claude · Agent mode" },
          ...exchangePrefix(),
        ],
      };
    case "human-message":
      return { surface: "thread", items: exchangePrefix() };
    case "agent-message":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          { id: "m-agent-1", kind: "message", author: "agent", authorName: AGENT, agentIcon: "bot", modeLabel: "Agent mode", text: "On it — I'll add a token-bucket limiter and wire it into the login route.", timestamp: "2:31 PM" },
        ],
      };
    case "thinking":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          { id: "th-1", kind: "thinking", streaming: true, lines: ["The login route is in server/src/routes/auth.ts.", "There's already an ipRateLimit helper I can reuse.", "I'll add a per-account bucket keyed on the email."] },
        ],
      };
    case "responding":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          { id: "m-agent-stream", kind: "message", author: "agent", authorName: AGENT, streaming: true, text: "I found an existing ipRateLimit helper, so I'll extend it with a per-account bucket and" },
        ],
      };
    case "tool-call":
      return {
        surface: "thread",
        items: [
          { id: "tool-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "in_progress" },
        ],
      };
    case "diff":
      return {
        surface: "thread",
        items: [
          {
            id: "tool-diff", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", decision: "allowed",
            diff: {
              path: "server/src/routes/auth.ts", added: 3, removed: 1,
              lines: [
                { kind: "context", text: "router.post('/login', async (req, res) => {" },
                { kind: "remove", text: "  const ok = await checkPassword(req.body);" },
                { kind: "add", text: "  await rateLimiter.consume(req.body.email);" },
                { kind: "add", text: "  const ok = await checkPassword(req.body);" },
                { kind: "add", text: "  if (!ok) return res.status(401).end();" },
              ],
            },
          },
        ],
      };
    case "working":
      return {
        surface: "thread",
        items: [
          { id: "st-working", kind: "status", status: "working", label: "Editing files", detail: "Edit · server/src/routes/auth.ts", toolName: "Edit", startedAtMs: Date.now() - 4200 },
        ],
      };
    case "running":
      return {
        surface: "thread",
        items: [
          { id: "st-running", kind: "status", status: "running", label: "Running", detail: "no output for 3s — still running", startedAtMs: Date.now() - 12000, tokens: { used: 18240, size: 200000 } },
        ],
      };
    case "completed":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-done",
            kind: "turn",
            settled: true,
            summary: { durationLabel: "38s", toolCount: 3, added: 34, removed: 3, tokensLabel: "12.3k tokens" },
            items: [
              { id: "th-done", kind: "thinking", lines: ["Read auth.ts", "Added rate-limiter util", "Wired into POST /login"] },
              { id: "tool-done-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              { id: "tool-done-2", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", diff: { path: "server/src/routes/auth.ts", added: 34, removed: 3 } },
            ],
          },
          { id: "m-done", kind: "message", author: "agent", authorName: AGENT, agentIcon: "bot", modeLabel: "Agent mode", text: "Done — added a per-account token-bucket limiter and wired it into the login route. Tests pass.", timestamp: "2:34 PM" },
        ],
      };
    case "awaiting-approval":
      return {
        surface: "thread",
        items: [
          {
            id: "st-approval", kind: "status", status: "awaiting_approval", label: "Approve running a command?",
            detail: "npm run migrate — modifies the database",
            approval: {
              toolName: "execute",
              options: [
                { id: "reject", label: "Deny", kind: "reject_once" },
                { id: "allow-always", label: "Always allow", kind: "allow_always" },
                { id: "allow", label: "Allow once", kind: "allow_once" },
              ],
            },
          },
        ],
      };
    case "plan-todo":
      return { surface: "plan", items: [], plan: SAMPLE_PLAN };
    case "interrupted":
      return {
        surface: "thread",
        items: [
          { id: "m-int", kind: "message", author: "agent", authorName: AGENT, text: "Starting the migration now…" },
          { id: "mk-int", kind: "marker", variant: "interrupted", label: "Interrupted", detail: "stopped by you at 2:35 PM" },
        ],
      };
    case "refused":
      return {
        surface: "thread",
        items: [
          { id: "st-refused", kind: "status", status: "refused", label: "Turn ended: refusal", detail: "The agent declined to complete this request." },
        ],
      };
    case "truncated":
      return {
        surface: "thread",
        items: [
          { id: "st-trunc", kind: "status", status: "truncated", label: "Turn ended: max tokens", detail: "Output was cut off — continue to resume.", tokens: { used: 199120, size: 200000 } },
        ],
      };
    case "live-token-cost":
      return {
        surface: "thread",
        items: [
          { id: "usage-1", kind: "usage", usage: { used: 42800, size: 200000, inputTokens: 38200, outputTokens: 4600, costUsd: 0.1284 } },
        ],
      };
    default: {
      const _never: never = id;
      return _never;
    }
  }
}
