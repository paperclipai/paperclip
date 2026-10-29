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
          { id: "mk-start", kind: "marker", variant: "session_start", label: "Session started", detail: "claude · Auto mode" },
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
          { id: "m-agent-1", kind: "message", author: "agent", authorName: AGENT, agentIcon: "bot", text: "On it — I'll add a token-bucket limiter and wire it into the login route.", timestamp: "2:31 PM" },
        ],
      };
    case "thinking":
      // The surviving thinking signal (PAP-361): the live line's "Thinking…"
      // state — Brain icon + shimmer on the pill. Thinking rows no longer
      // render in the thread or nest under turns.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-thinking",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: { id: "st-thinking", kind: "status", status: "running", label: "Thinking", startedAtMs: Date.now() - 6100, tokens: { used: 18240, size: 200000 } },
            items: [
              { id: "th-grep", kind: "tool", name: "Grep", target: "rateLimit", toolKind: "search", status: "completed" },
            ],
          },
        ],
      };
    case "responding":
      // A streaming interstitial update gets its own row directly above the
      // status line (PAP-361, amended): it wraps into the 1lh viewport
      // line-scroll while the gerund rotation below runs uninterrupted.
      // Ephemeral — when it finishes, the row slides out and the text renders
      // nowhere.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-responding",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: {
              id: "st-responding", kind: "status", status: "running", label: "Responding", startedAtMs: Date.now() - 9300, tokens: { used: 18240, size: 200000 },
              selfTalk:
                "I found an existing ipRateLimit helper, so I'll extend it with a per-account token bucket keyed on the email address instead of adding a second limiter. The bucket refills at six requests a minute, matching the lockout policy the auth spec documents, and failed attempts drain it twice as fast so brute-force runs hit the ceiling quickly while a fat-fingered password barely registers.",
            },
            items: [
              { id: "resp-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
            ],
          },
        ],
      };
    case "responding-burst":
      // A run emitting several interstitial updates in quick succession
      // (PAP-368): the lab replay streams each blank-line-separated segment as
      // its own update with a short gap between. The pill HOLDS each finished
      // update until the next swaps in, paced by --motion-interstitial-dwell
      // (latest-wins when updates outpace the dwell).
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-responding-burst",
            kind: "turn",
            settled: false,
            summary: { toolCount: 2, added: 0, removed: 0 },
            liveStatus: {
              id: "st-responding-burst", kind: "status", status: "running", label: "Responding", startedAtMs: Date.now() - 21400, tokens: { used: 18240, size: 200000 },
              selfTalk:
                "Found the existing ipRateLimit helper — extending it beats adding a second limiter.\n\n" +
                "Wiring a per-account token bucket keyed on the email address, refilling at six requests a minute per the auth spec.\n\n" +
                "Failed attempts drain the bucket twice as fast, so brute-force runs hit the ceiling while a fat-fingered password barely registers.\n\n" +
                "Now updating the login route to consume from the bucket before the password check and adding tests for the lockout path.",
            },
            items: [
              { id: "burst-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              { id: "burst-grep", kind: "tool", name: "Grep", target: "ipRateLimit", toolKind: "search", status: "completed" },
            ],
          },
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
      // Parent-row live turn (PAP-354): the tool-state line owns the activity;
      // expanding nests the chronological history underneath.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-working",
            kind: "turn",
            settled: false,
            summary: { toolCount: 2, added: 0, removed: 0 },
            liveStatus: { id: "st-working", kind: "status", status: "working", label: "Editing files", detail: "Edit · server/src/routes/auth.ts", toolName: "Edit", startedAtMs: Date.now() - 4200 },
            items: [
              { id: "w-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              { id: "w-edit", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "in_progress" },
            ],
          },
        ],
      };
    case "running":
      // Generic label → the parent row header rotates whimsical gerunds.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-running",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: { id: "st-running", kind: "status", status: "running", label: "Running", detail: "no output for 3s — still running", startedAtMs: Date.now() - 12000, tokens: { used: 18240, size: 200000 } },
            items: [
              { id: "r-grep", kind: "tool", name: "Grep", target: "rateLimit", toolKind: "search", status: "completed" },
            ],
          },
        ],
      };
    case "completed":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          // Round 9: the settled turn attaches to the final reply bubble — the
          // "✓ Worked · …" summary renders on the bubble's always-visible
          // timestamp line ("2:34 PM · ✓ Worked · 38s · 2 tools").
          {
            id: "m-done",
            kind: "message",
            author: "agent",
            authorName: AGENT,
            agentIcon: "bot",
            text: "Done — added a per-account token-bucket limiter and wired it into the login route. Tests pass.",
            timestamp: "2:34 PM",
            attachedTurn: {
              id: "turn-done",
              kind: "turn",
              settled: true,
              // "Worked · N tools" expands to exactly the tool rows (PAP-361):
              // toolCount matches the nested rows, no thinking row.
              summary: { durationLabel: "38s", toolCount: 2, added: 34, removed: 3, tokensLabel: "12.3k tokens" },
              items: [
                { id: "tool-done-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
                { id: "tool-done-2", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", diff: { path: "server/src/routes/auth.ts", added: 34, removed: 3 } },
              ],
            },
          },
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
    case "activity-phases": {
      const phase = (id: string, text: string | undefined, active: boolean, tools: TaskChatItem[]) => ({
        id,
        kind: "activity_phase" as const,
        active,
        interstitial: text ? { id: `${id}:message`, kind: "message" as const, author: "agent" as const, authorName: AGENT, text, interstitial: true } : undefined,
        items: tools.filter((item): item is Extract<TaskChatItem, { kind: "tool" | "usage" }> => item.kind === "tool" || item.kind === "usage"),
        summary: active ? "Ran 1 command, called 1 tool" : id.endsWith("opening") ? "Called 2 tools" : "Read 3 files, edited 1 file",
      });
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-long-run", kind: "turn", settled: false,
            summary: { toolCount: 8, added: 4, removed: 1 },
            liveStatus: { id: "long-status", kind: "status", status: "working", label: "Running tests", detail: "Bash · vitest", toolName: "Bash", startedAtMs: Date.now() - 48_000 },
            items: [
              phase("phase-opening", undefined, false, [
                { id: "generic-1", kind: "tool", name: "Tool", rawName: "tool call", status: "completed" },
                { id: "generic-2", kind: "tool", name: "Tool", rawName: "acp_tool", status: "failed", detail: "Adapter interrupted" },
              ]),
              phase("phase-read", "I found the relevant adapter and am tracing its render boundary.", false, [
                { id: "read-1", kind: "tool", name: "Read", status: "completed", target: "ui/src/components/task-chat/transcript-adapter.ts" },
                { id: "read-2", kind: "tool", name: "Read", status: "completed", target: "ui/src/components/task-chat/TaskChatTurn.tsx" },
                { id: "read-3", kind: "tool", name: "Read", status: "completed", target: "ui/src/components/task-chat/TaskChatThreadView.tsx" },
                { id: "edit-1", kind: "tool", name: "Edit", status: "completed", target: "ui/src/components/task-chat/task-chat-model.ts" },
              ]),
              phase("phase-active", "The grouping is wired; I’m running focused checks now.", true, [
                { id: "bash-1", kind: "tool", name: "Bash", status: "in_progress", target: "vitest task-chat" },
                { id: "mcp-1", kind: "tool", name: "Search", rawName: "mcp__docs__search", status: "completed" },
              ]),
            ],
          },
        ],
      };
    }
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
