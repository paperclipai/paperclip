import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { nativeRunEventsToTranscript } from "@/components/transcript/native-run-events";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatExpansionState } from "@/components/task-chat/expansion-state";
import {
  buildTurnTimelineRows,
  transcriptToTaskChatItems,
} from "@/components/task-chat/transcript-adapter";
import type { TaskChatMessageItem, TaskChatTurnItem } from "@/components/task-chat/task-chat-model";

/**
 * Provider activity that the runner already maps to canonical events (web
 * research, model reroutes, intentional waits and the run's own verification
 * checks) rendered through the production path: persisted run events →
 * nativeRunEventsToTranscript → transcriptToTaskChatItems → runner turn.
 */

const RUN_ID = "10000000-0000-4000-8000-0000000000a1";
let baseMs = Date.parse("2026-11-05T16:20:00.000Z");
let seqCounter = 0;
function runEvent(
  eventType: string,
  payload: Record<string, unknown>,
  options: { itemId?: string; offsetMs?: number } = {},
): HeartbeatRunEvent {
  const seq = ++seqCounter;
  const emittedAt = new Date(baseMs + (options.offsetMs ?? seq * 1500)).toISOString();
  return {
    id: seq,
    companyId: "10000000-0000-4000-8000-0000000000a2",
    runId: RUN_ID,
    agentId: "10000000-0000-4000-8000-0000000000a3",
    seq,
    eventType,
    stream: "system",
    level: "info",
    color: null,
    message: null,
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        sourceEventId: `provider-activity-${seq}`,
        sourceSeq: seq,
        sourceInstanceId: "runner-story",
        sourceKind: "runner",
        runId: RUN_ID,
        normalizedSessionId: "session-story",
        eventType,
        schemaVersion: 1,
        priority: 1,
        emittedAt,
        ...(options.itemId ? { itemId: options.itemId } : {}),
        payload,
      },
    },
    createdAt: new Date(emittedAt),
  };
}

function message(itemId: string, text: string, channel: "commentary" | "final" = "commentary") {
  return runEvent("item.completed", { itemId, kind: "agentMessage", channel, text }, { itemId });
}

function command(executionId: string, name: string, output: string, status: "completed" | "failed" = "completed") {
  const base = {
    schema: "paperclip.tool.execution.v1",
    executionId,
    transport: "process",
    operation: "execute",
    name,
    outputTruncated: false,
    outputDigest: null,
  };
  return [
    runEvent("tool.execution.started", { ...base, status: "running", output: null, outputBytes: 0 }),
    runEvent("tool.execution.completed", { ...base, status, output, outputBytes: output.length, exitCode: status === "failed" ? 1 : 0 }),
  ];
}

function webSearch(researchId: string, query: string, sources: Array<{ url: string; title: string; snippet?: string }>) {
  const base = { schema: "paperclip.research.v1", researchId, action: "search", query, url: null, pattern: null };
  return [
    runEvent("research.started", { ...base, status: "running", sources: [] }, { itemId: researchId }),
    runEvent("research.completed", {
      ...base,
      status: "completed",
      sources: sources.map((source, index) => ({ sourceId: `${researchId}-${index}`, snippet: null, ...source })),
    }, { itemId: researchId }),
  ];
}

function openPage(researchId: string, url: string) {
  const base = { schema: "paperclip.research.v1", researchId, action: "open_page", query: null, url, pattern: null, sources: [] };
  return [
    runEvent("research.started", { ...base, status: "running" }, { itemId: researchId }),
    runEvent("research.completed", { ...base, status: "completed" }, { itemId: researchId }),
  ];
}

function verification(itemId: string, status: "passed" | "failed" | "not_run", commandOrCheck: string, detail?: string) {
  return runEvent("item.completed", {
    kind: "verification",
    text: `${status}: ${commandOrCheck}`,
    verification: { commandOrCheck, status, ...(detail ? { detail } : {}) },
  }, { itemId });
}

function buildRunEvents(startMs: number): HeartbeatRunEvent[] {
  seqCounter = 0;
  baseMs = startMs;
  return [
    message("m1", "I’ll check how `Temporal.PlainDate.from` treats ISO week dates before touching the parser."),
    ...webSearch("ws-1", "Temporal.PlainDate.from ISO 8601 week date support", [
      { url: "https://tc39.es/proposal-temporal/docs/plaindate.html", title: "Temporal.PlainDate — TC39 proposal docs", snippet: "PlainDate.from() accepts ISO 8601 calendar dates; week dates are rejected." },
      { url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/PlainDate/from", title: "Temporal.PlainDate.from() - JavaScript | MDN", snippet: "Creates a new Temporal.PlainDate object from another object or a string." },
      { url: "https://github.com/tc39/proposal-temporal/issues/2312", title: "Support ISO week-date strings in from() · Issue #2312", snippet: "Week dates such as 2026-W45-4 are intentionally out of scope." },
      { url: "https://nodejs.org/en/blog/release/v24.0.0", title: "Node.js 24.0.0 release notes", snippet: "Temporal ships behind --harmony-temporal." },
      { url: "https://stackoverflow.com/questions/77123456/parse-iso-week-date-javascript", title: "Parse an ISO week date in JavaScript - Stack Overflow" },
    ]),
    ...openPage("ws-2", "https://tc39.es/proposal-temporal/docs/plaindate.html"),
    runEvent("model.route.changed", {
      schema: "paperclip.model.route_changed.v1",
      routeId: "turn-1",
      provider: "openai",
      requestedModel: "gpt-5.6-sol",
      fromModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-luna",
      reason: "capacity",
    }),
    message("m2", "Week dates aren’t supported upstream, so I’ll parse them in `parseExportDate` and add tests."),
    ...command("c1", "rg -n parseExportDate server/src", "server/src/export/worker.ts:42:export function parseExportDate("),
    ...command("c2", "node --test server/src/export/worker.test.ts", "✔ parses calendar dates\n✖ parses ISO week dates\n\n5 passed, 1 failed", "failed"),
    runEvent("wait.started", {
      schema: "paperclip.wait.v1",
      waitId: "sleep-1",
      reason: "timer",
      status: "running",
      plannedDurationMs: 30_000,
      elapsedDurationMs: null,
    }, { itemId: "sleep-1" }),
    runEvent("wait.completed", {
      schema: "paperclip.wait.v1",
      waitId: "sleep-1",
      reason: "timer",
      status: "completed",
      plannedDurationMs: 30_000,
      elapsedDurationMs: 30_000,
    }, { itemId: "sleep-1" }),
    ...command("c3", "node --test server/src/export/worker.test.ts", "✔ parses calendar dates\n✔ parses ISO week dates\n\n6 passed"),
    verification("v1", "passed", "node --test server/src/export/worker.test.ts", "6 tests passed"),
    verification("v2", "failed", "pnpm --filter @paperclipai/server typecheck", "2 errors in src/export/worker.ts"),
    verification("v3", "not_run", "pnpm test:e2e", "Browser suite not needed for a parser change"),
    message("final", "Week-date strings like `2026-W45-4` now parse to the matching calendar day. The worker tests pass; typecheck still reports two errors in the worker that predate this change.", "final"),
  ];
}

function useStoryItems(cutoff?: number) {
  return useMemo(() => {
    // Live stories end "now" so a running wait shows a real countdown.
    const events = buildRunEvents(cutoff == null ? Date.parse("2026-11-05T16:20:00.000Z") : Date.now() - cutoff * 1500 - 8_000);
    const visible = cutoff == null ? events : events.slice(0, cutoff);
    const transcript = nativeRunEventsToTranscript(visible);
    return transcriptToTaskChatItems(transcript, { runId: RUN_ID, running: cutoff != null });
  }, [cutoff]);
}

function Frame({ children, narrow = false }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className={narrow ? "mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-8" : "mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8"}>
        <div className="self-end rounded-xl bg-muted px-4 py-3 text-sm">
          The export worker rejects ISO week dates like 2026-W45-4. Can you fix the parser?
        </div>
        {children}
      </main>
    </div>
  );
}

function SettledRun({ narrow = false }: { narrow?: boolean }) {
  const items = useStoryItems();
  const memory = useMemo(() => new Map<string, boolean>(), []);
  const rows = buildTurnTimelineRows(items, false);
  for (const row of rows) if (row.kind === "activity_phase") memory.set(row.id, true);
  const finalResponse = items.find(
    (item): item is TaskChatMessageItem => item.kind === "message" && item.channel === "final",
  );
  const turn: TaskChatTurnItem = {
    id: "provider-activity-turn",
    kind: "turn",
    settled: true,
    standaloneHeader: true,
    agentName: "Engineer",
    agentIcon: "code",
    items: rows,
    summary: { durationLabel: "2m 14s", toolCount: 3, added: 38, removed: 4 },
    finalResponse,
  };
  return (
    <Frame narrow={narrow}>
      <TaskChatExpansionState.Provider value={memory}>
        <TaskChatThreadView scroll={false} items={[turn]} />
      </TaskChatExpansionState.Provider>
    </Frame>
  );
}

function LiveRun({ cutoff, narrow = false }: { cutoff: number; narrow?: boolean }) {
  const items = useStoryItems(cutoff);
  const memory = useMemo(() => new Map<string, boolean>(), []);
  for (const row of buildTurnTimelineRows(items, true)) if (row.kind === "activity_phase") memory.set(row.id, true);
  return (
    <Frame narrow={narrow}>
      <TaskChatExpansionState.Provider value={memory}>
        <TaskChatRunnerTurn
          runId={RUN_ID}
          agentName="Engineer"
          agentIcon="code"
          items={items}
          status="running"
          startedAtMs={Date.now() - 74_000}
        />
      </TaskChatExpansionState.Provider>
    </Frame>
  );
}

const meta = {
  id: "tasks-task-chat-provider-activity",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/Task chat/Provider activity",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Web research, model reroutes, intentional waits and verification checks from a Codex run. The fixtures are persisted run events and pass through nativeRunEventsToTranscript and transcriptToTaskChatItems, the live task-chat path.",
      },
    },
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SettledExpanded: Story = {
  name: "01 · Settled run · expanded",
  render: () => <SettledRun />,
};

export const LiveSearching: Story = {
  name: "02 · Live · searching the web",
  render: () => <LiveRun cutoff={2} />,
};

export const LiveWaiting: Story = {
  name: "03 · Live · intentional wait",
  render: () => <LiveRun cutoff={12} />,
};

export const SettledNarrow: Story = {
  name: "04 · Settled run · narrow",
  render: () => <SettledRun narrow />,
};
