import type { HarnessRuntimeRequestKind } from "../contracts/harness-driver.js";
import type { NativeSessionCapabilities } from "../contracts/types.js";

/**
 * A demo chat manifest is a deterministic script for the Live console browser
 * tracer. Every state named in the interaction map has to be reachable from
 * one of these manifests, and the manifest — not the browser — owns the list
 * of observations a human is expected to confirm.
 */
export type LiveConsoleDemoBeat =
  | { kind: "reasoning"; itemId: string; chunks: readonly string[] }
  | { kind: "assistant"; itemId: string; chunks: readonly string[] }
  | {
      kind: "tool";
      itemId: string;
      name: string;
      input: string;
      output?: string;
      failure?: string;
      /** Stay in flight until an interrupt or the bounded demo timeout. */
      hold?: boolean;
    }
  | {
      kind: "request";
      requestId: string;
      requestKind: HarnessRuntimeRequestKind;
      method: string;
      itemId: string;
      prompt: string;
      details: Record<string, unknown>;
      /** Resolution actions the upstream request actually offers. */
      actions: readonly string[];
      /** Expire the request when nobody answers within the bounded window. */
      expiresAfterMs?: number;
    }
  | {
      kind: "child";
      threadId: string;
      nickname: string;
      role: string;
      statuses: readonly string[];
    }
  | { kind: "hold"; note: string }
  | { kind: "diagnostic"; message: string };

export interface LiveConsoleDemoManifest {
  id: string;
  name: string;
  purpose: string;
  scenarios: readonly string[];
  objective: string;
  prompt: string;
  capabilities: NativeSessionCapabilities;
  /** Milliseconds between `turn.submitted` and `turn.accepted`. */
  startDelayMs: number;
  beats: readonly LiveConsoleDemoBeat[];
  /** Beats used by every turn after the first one. */
  followUpBeats?: readonly LiveConsoleDemoBeat[];
  expectedObservations: readonly string[];
  disposition: "completed" | "failed";
}

const FULL_CAPABILITIES: NativeSessionCapabilities = {
  resume: true,
  typedEvents: true,
  steering: true,
  interruption: true,
  structuredResult: true,
  read: true,
  reconciliation: true,
  usage: true,
  runtimeRequestResolution: true,
  goals: true,
  threadLineage: true,
};

function capabilities(
  overrides: Partial<NativeSessionCapabilities> = {},
): NativeSessionCapabilities {
  return { ...FULL_CAPABILITIES, ...overrides };
}

const SHORT_ANSWER: readonly string[] = [
  "I read the objective, ",
  "checked the working directory, ",
  "and finished the task.",
];

export const LIVE_CONSOLE_DEMO_MANIFESTS: readonly LiveConsoleDemoManifest[] = [
  {
    id: "chat",
    name: "Regular chat",
    purpose: "Send normal chat messages while the protocol inspector shows the raw lifecycle.",
    scenarios: ["direct-chat", "transcript", "debug"],
    objective: "Run a normal Codex conversation through the browser protocol.",
    prompt: "Say hello and explain that this is a normal chat through the runner protocol.",
    capabilities: capabilities({ structuredResult: false }),
    startDelayMs: 0,
    beats: [
      {
        kind: "assistant",
        itemId: "assistant-chat-1",
        chunks: ["Hello. This is a normal chat carried through the runner protocol."],
      },
    ],
    followUpBeats: [
      {
        kind: "assistant",
        itemId: "assistant-chat-follow-up",
        chunks: ["I received your follow-up message through the same session."],
      },
    ],
    expectedObservations: [
      "The prompt reaches the driver as plain text without a Codex task envelope.",
      "The answer appears as a normal assistant message.",
      "The protocol inspector still shows the event stream and reducer state.",
    ],
    disposition: "completed",
  },
  {
    id: "completion",
    name: "Completion",
    purpose: "One clean turn: reasoning, a tool call, an answer, and a terminal result.",
    scenarios: ["transcript", "streaming", "terminal"],
    objective: "Summarize the Live console boundary.",
    prompt: "Summarize what the Live console demo server proves.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "reasoning",
        itemId: "reasoning-1",
        chunks: ["Reading the objective. ", "The task is a summary, so no writes are needed."],
      },
      {
        kind: "tool",
        itemId: "tool-1",
        name: "read_file",
        input: "docs/live-console-protocol-server.md",
        output: "The browser boundary is HTTP plus server-sent events.",
      },
      { kind: "assistant", itemId: "assistant-1", chunks: SHORT_ANSWER },
    ],
    followUpBeats: [
      { kind: "assistant", itemId: "assistant-follow", chunks: ["Follow-up turns reuse the same session."] },
    ],
    expectedObservations: [
      "The transcript shows reasoning collapsed and the answer expanded.",
      "The tool item shows its input and output in a monospace block.",
      "The turn ends with a completed badge and a structured result.",
    ],
    disposition: "completed",
  },
  {
    id: "steering",
    name: "Same-turn steering",
    purpose: "Steer a running turn, watch the acknowledgement, then watch a stale steer get rejected.",
    scenarios: ["steering", "stale-turn"],
    objective: "Keep the answer short.",
    prompt: "Explain the steering contract, then wait for further direction.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "reasoning",
        itemId: "reasoning-1",
        chunks: ["Starting a long answer so there is time to steer."],
      },
      {
        kind: "assistant",
        itemId: "assistant-1",
        chunks: [
          "Steering is bound to the turn that was active when the message was composed. ",
          "The driver compares the expected turn id before it accepts the text. ",
          "A mismatch is rejected instead of being applied to a different turn.",
        ],
      },
    ],
    expectedObservations: [
      "A steering chip appears as pending and then becomes acknowledged.",
      "Steering sent after the turn ends is rejected as a stale turn.",
      "The rejected chip keeps the typed text and offers to send it as a new message.",
    ],
    disposition: "completed",
  },
  {
    id: "interrupt-before-start",
    name: "Interrupt before start",
    purpose: "Press stop while the turn is still waiting for a provider turn id.",
    scenarios: ["interrupt"],
    objective: "Cancel before the provider starts.",
    prompt: "Start a slow turn so it can be cancelled before it starts.",
    capabilities: capabilities(),
    startDelayMs: 4_000,
    beats: [{ kind: "assistant", itemId: "assistant-1", chunks: ["The turn started after all."] }],
    expectedObservations: [
      "The composer sits in the submitting state while the turn waits to start.",
      "Stop resolves the pending turn to `Cancelled before start`.",
      "No assistant item is ever created for the cancelled turn.",
    ],
    disposition: "completed",
  },
  {
    id: "interrupt-during-generation",
    name: "Interrupt during generation",
    purpose: "Stop a streaming answer and keep the partial text.",
    scenarios: ["interrupt", "streaming"],
    objective: "Stop mid-answer.",
    prompt: "Write a long answer so it can be interrupted while streaming.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "assistant",
        itemId: "assistant-1",
        chunks: [
          "The tracer keeps every partial token that arrived before the stop. ",
          "It never blanks an interrupted item, ",
          "because the partial record is the point of a tracer. ",
          "This sentence exists so the stream lasts long enough to interrupt. ",
          "And this one too. ",
          "And this final one.",
        ],
      },
    ],
    expectedObservations: [
      "The stream stops in place and the partial text stays visible.",
      "The item shows an interrupted divider instead of a completed state.",
      "The turn group shows an interrupted badge.",
    ],
    disposition: "completed",
  },
  {
    id: "interrupt-during-tool",
    name: "Interrupt during a tool call",
    purpose: "Stop while a tool call is running and keep its last known status.",
    scenarios: ["interrupt", "tools"],
    objective: "Stop during a tool call.",
    prompt: "Run a slow tool so it can be interrupted.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "tool",
        itemId: "tool-1",
        name: "run_command",
        input: "sleep 30 && echo done",
        hold: true,
      },
      { kind: "assistant", itemId: "assistant-1", chunks: ["The tool finished."] },
    ],
    expectedObservations: [
      "The tool item stays running until the stop is pressed.",
      "The interrupted tool item keeps its last known status and no fabricated result.",
      "The turn group shows an interrupted badge.",
    ],
    disposition: "completed",
  },
  {
    id: "approvals",
    name: "Command and file approvals",
    purpose: "Resolve a command approval and a file-change approval from the transcript.",
    scenarios: ["requests", "approvals"],
    objective: "Approve the demo command and file change.",
    prompt: "Ask for approval before running the command and writing the file.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "request",
        requestId: "request-command",
        requestKind: "command_approval",
        method: "item/commandExecution/requestApproval",
        itemId: "command-1",
        prompt: "Run the deterministic demo command?",
        details: { command: "node scripts/live-console-demo-check.mjs --dry-run", cwd: "<server-path>" },
        actions: ["accept", "accept_for_session", "decline", "cancel"],
      },
      {
        kind: "request",
        requestId: "request-file",
        requestKind: "file_approval",
        method: "item/fileChange/requestApproval",
        itemId: "file-1",
        prompt: "Write live-console-demo.txt?",
        details: {
          path: "live-console-demo.txt",
          diff: "+liveConsole demo evidence\n",
          changeKind: "add",
        },
        actions: ["accept", "decline"],
      },
      { kind: "assistant", itemId: "assistant-1", chunks: ["Both approvals were honoured exactly once."] },
    ],
    expectedObservations: [
      "Each request card renders only the actions the request offers.",
      "The first click disables the whole action row until the resolved event arrives.",
      "A resolved card collapses to one summary line that names the chosen action.",
    ],
    disposition: "completed",
  },
  {
    id: "user-input",
    name: "User input and expiry",
    purpose:
      "Answer a typed user-input request and an elicitation, then watch an unanswered request expire.",
    scenarios: ["requests", "user-input", "elicitation", "expiry"],
    objective: "Collect the deployment target and release channel, then let a request expire.",
    prompt:
      "Ask which environment and channel to use, then ask a question nobody answers.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "request",
        requestId: "request-input",
        requestKind: "user_input",
        method: "item/tool/requestUserInput",
        itemId: "input-1",
        prompt: "Which environment should the demo target?",
        details: { fields: [{ name: "environment", label: "Environment" }] },
        actions: ["submit", "decline", "cancel"],
      },
      {
        kind: "request",
        requestId: "request-elicitation",
        requestKind: "elicitation",
        method: "mcpServer/elicitation/request",
        itemId: "input-2",
        prompt: "Which release channel should the tool use?",
        details: { fields: [{ name: "channel", label: "Channel" }] },
        actions: ["submit", "decline", "cancel"],
      },
      {
        kind: "request",
        requestId: "request-expiring",
        requestKind: "elicitation",
        method: "mcpServer/elicitation/request",
        itemId: "input-3",
        prompt: "Optional detail — this request expires if nobody answers.",
        details: { fields: [{ name: "detail", label: "Detail" }] },
        actions: ["submit", "decline", "cancel"],
        expiresAfterMs: 8_000,
      },
      { kind: "assistant", itemId: "assistant-1", chunks: ["The expired request stays in the record."] },
    ],
    expectedObservations: [
      "The user-input card renders a text field and a submit action.",
      "The elicitation card submits its answer as content and resolves.",
      "The submitted answer never appears in the resolution acknowledgement.",
      "The unanswered request resolves to `expired before response` on its own.",
    ],
    disposition: "completed",
  },
  {
    id: "subagents",
    name: "Parent and child threads",
    purpose: "Watch child threads start, report, and reach a terminal state.",
    scenarios: ["lineage", "subagents"],
    objective: "Delegate two checks to child threads.",
    prompt: "Spawn two child threads and report what they found.",
    capabilities: capabilities({ steering: true }),
    startDelayMs: 0,
    beats: [
      {
        kind: "child",
        threadId: "thread-child-a",
        nickname: "docs-check",
        role: "reviewer",
        statuses: ["starting", "running", "completed"],
      },
      {
        kind: "child",
        threadId: "thread-child-b",
        nickname: "test-check",
        role: "reviewer",
        statuses: ["starting", "running", "failed"],
      },
      { kind: "assistant", itemId: "assistant-1", chunks: ["One child finished and one child failed."] },
    ],
    expectedObservations: [
      "The lineage tree lists the root session and both child threads.",
      "Child terminal states stay in the tree after the turn ends.",
      "Selecting a child shows an explicitly disabled composer with the exact diagnostic.",
    ],
    disposition: "completed",
  },
  {
    id: "goals",
    name: "Goal lifecycle",
    purpose: "Set, pause, resume, and clear a durable goal.",
    scenarios: ["goals", "capabilities"],
    objective: "Keep the demo goal visible.",
    prompt: "Work under a durable goal.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      { kind: "assistant", itemId: "assistant-1", chunks: ["Use the goal menu to change the goal state."] },
    ],
    expectedObservations: [
      "The goal banner shows the active goal and its last transition time.",
      "Pause and resume are disabled when they are invalid for the current state.",
      "Every goal change is also a transcript event, so replay shows the same history.",
    ],
    disposition: "completed",
  },
  {
    id: "goals-unsupported",
    name: "Goals unsupported",
    purpose: "Show the exact capability diagnostic instead of hiding the control.",
    scenarios: ["goals", "capabilities"],
    objective: "Prove unsupported capabilities are visible.",
    prompt: "Run against an app-server that does not advertise goals.",
    capabilities: capabilities({
      goals: false,
      unsupported: [
        "Goal operations unsupported: app-server 0.132.0 does not advertise the goals capability",
      ],
    }),
    startDelayMs: 0,
    beats: [
      {
        kind: "assistant",
        itemId: "assistant-1",
        chunks: ["The goal menu stays visible and disabled with the upstream diagnostic."],
      },
    ],
    expectedObservations: [
      "The goal menu is disabled, not hidden.",
      "The exact capability diagnostic is readable without hovering.",
      "The inspector capabilities tab shows the same unsupported string.",
    ],
    disposition: "completed",
  },
  {
    id: "failure",
    name: "Item and turn failure",
    purpose: "Show a failed item and a failed turn as part of the record.",
    scenarios: ["failure", "diagnostics"],
    objective: "Fail on purpose.",
    prompt: "Run a command that fails.",
    capabilities: capabilities(),
    startDelayMs: 0,
    beats: [
      {
        kind: "tool",
        itemId: "tool-1",
        name: "run_command",
        input: "node scripts/missing.mjs",
        failure: "Command exited with status 1: cannot find module scripts/missing.mjs",
      },
      { kind: "diagnostic", message: "The demo task cannot continue after the failed command." },
    ],
    expectedObservations: [
      "The failed item renders in place with the exact diagnostic string.",
      "No failure is reported only as a transient notification.",
      "The turn ends in a failed state and the run result reports the failure.",
    ],
    disposition: "failed",
  },
];

export function findLiveConsoleDemoManifest(id: string): LiveConsoleDemoManifest {
  const manifest = LIVE_CONSOLE_DEMO_MANIFESTS.find((candidate) => candidate.id === id);
  if (manifest === undefined) {
    throw new Error(`unknown Live console demo manifest ${id}`);
  }
  return manifest;
}

export interface LiveConsoleDemoManifestSummary {
  id: string;
  name: string;
  purpose: string;
  scenarios: readonly string[];
  objective: string;
  prompt: string;
  expectedObservations: readonly string[];
}

export function liveConsoleDemoManifestCatalogue(): LiveConsoleDemoManifestSummary[] {
  return LIVE_CONSOLE_DEMO_MANIFESTS.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    purpose: manifest.purpose,
    scenarios: [...manifest.scenarios],
    objective: manifest.objective,
    prompt: manifest.prompt,
    expectedObservations: [...manifest.expectedObservations],
  }));
}
