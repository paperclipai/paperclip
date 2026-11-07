import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { parseUnifiedDiffLines } from "@/components/task-chat/diff-lines";
import { TaskChatExpansionState } from "@/components/task-chat/expansion-state";
import { expect, userEvent, within } from "storybook/test";
import type {
  TaskChatDiff,
  TaskChatItem,
  TaskChatWorkspaceChangeItem,
} from "@/components/task-chat/task-chat-model";

function diff(path: string, patch: string): TaskChatDiff {
  const parsed = parseUnifiedDiffLines(patch);
  return { path, added: parsed.added, removed: parsed.removed, lines: parsed.lines };
}

const WORKER_PATCH = `--- a/server/src/services/webhook-delivery.ts
+++ b/server/src/services/webhook-delivery.ts
@@ -41,9 +41,18 @@ export async function deliverWebhook(
   const attempt = await db.webhookAttempts.next(event.id);
-  const response = await fetch(endpoint.url, {
-    method: "POST",
-    body: JSON.stringify(event.payload),
-  });
+  if (await db.webhookDeliveries.exists(event.id, endpoint.id)) {
+    logger.info({ eventId: event.id }, "skip duplicate webhook delivery");
+    return { status: "duplicate" };
+  }
+  const response = await fetch(endpoint.url, {
+    method: "POST",
+    headers: { "Idempotency-Key": event.id },
+    body: JSON.stringify(event.payload),
+  });
+  await db.webhookDeliveries.record(event.id, endpoint.id, response.status);
   if (!response.ok) {
     throw new RetryableDeliveryError(response.status);
   }`;

const SCHEMA_PATCH = `--- a/packages/db/src/schema/webhook_deliveries.ts
+++ b/packages/db/src/schema/webhook_deliveries.ts
@@ -12,6 +12,9 @@ export const webhookDeliveries = pgTable(
     status: integer("status").notNull(),
     createdAt: timestamp("created_at").defaultNow().notNull(),
   },
-  (table) => [index("webhook_deliveries_event_idx").on(table.eventId)],
+  (table) => [
+    index("webhook_deliveries_event_idx").on(table.eventId),
+    uniqueIndex("webhook_deliveries_event_endpoint_uq").on(table.eventId, table.endpointId),
+  ],
 );`;

const TEST_PATCH = `--- /dev/null
+++ b/server/src/services/webhook-delivery.test.ts
@@ -0,0 +1,24 @@
+import { describe, expect, it } from "vitest";
+import { deliverWebhook } from "./webhook-delivery";
+import { fakeDb, fakeEndpoint, fakeEvent } from "../test/webhook-fixtures";
+
+describe("deliverWebhook", () => {
+  it("delivers a retried event once", async () => {
+    const db = fakeDb();
+    const sent: string[] = [];
+    const fetch = async (url: string) => {
+      sent.push(url);
+      return new Response(null, { status: 200 });
+    };
+    await deliverWebhook(db, fakeEndpoint(), fakeEvent("evt_1"), { fetch });
+    const second = await deliverWebhook(db, fakeEndpoint(), fakeEvent("evt_1"), { fetch });
+    expect(sent).toHaveLength(1);
+    expect(second.status).toBe("duplicate");
+  });
+
+  it("sends the event id as the idempotency key", async () => {
+    const headers = await captureHeaders(fakeEvent("evt_2"));
+    expect(headers.get("Idempotency-Key")).toBe("evt_2");
+  });
+});
+`;

const workerDiff = diff("server/src/services/webhook-delivery.ts", WORKER_PATCH);
const schemaDiff = diff("packages/db/src/schema/webhook_deliveries.ts", SCHEMA_PATCH);
const testDiff = diff("server/src/services/webhook-delivery.test.ts", TEST_PATCH);

function workspaceChange(complete: boolean): TaskChatWorkspaceChangeItem {
  const files = [
    { path: workerDiff.path!, operation: "modify" as const, patch: WORKER_PATCH, d: workerDiff },
    { path: schemaDiff.path!, operation: "modify" as const, patch: SCHEMA_PATCH, d: schemaDiff },
    { path: testDiff.path!, operation: "create" as const, patch: TEST_PATCH, d: testDiff },
  ].map(({ path, operation, patch, d }) => ({
    path,
    operation,
    previousPath: null,
    additions: d.added,
    deletions: d.removed,
    binary: false,
    diff: patch,
  }));
  return {
    id: "run-edit-diffs:workspace",
    kind: "protocol",
    surface: "workspace_change",
    changeSetId: "turn-1:workspace",
    revision: 4,
    source: "harness_reported",
    complete,
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    patchArtifactRef: null,
  };
}

const completedItems: TaskChatItem[] = [
  {
    id: "thinking-1",
    kind: "thinking",
    lines: ["Tracing the retry path in the delivery worker."],
    channel: "summary",
    transcriptIndex: 1,
  },
  { id: "read-1", kind: "tool", name: "Read", rawName: "read_file", target: "server/src/services/webhook-delivery.ts", status: "completed" },
  { id: "edit-1", kind: "tool", name: "Edit", rawName: "edit", toolKind: "edit", target: workerDiff.path, status: "completed", diff: workerDiff },
  { id: "edit-2", kind: "tool", name: "Edit", rawName: "edit", toolKind: "edit", target: schemaDiff.path, status: "completed", diff: schemaDiff },
  { id: "write-1", kind: "tool", name: "Write", rawName: "write", toolKind: "edit", target: testDiff.path, status: "completed", diff: testDiff },
  { id: "bash-1", kind: "tool", name: "Bash", rawName: "bash", target: "pnpm vitest run server/src/services/webhook-delivery.test.ts", status: "completed", detail: "✓ 2 passed (412ms)" },
  workspaceChange(true),
  {
    id: "final-1",
    kind: "message",
    author: "agent",
    authorName: "CodexRunner",
    channel: "final",
    text: "Deliveries are now idempotent on the event id. A unique index backs the check, and a regression test covers a retried event.",
  },
];

const runningItems: TaskChatItem[] = [
  completedItems[0],
  completedItems[1],
  completedItems[2],
  { ...completedItems[3], status: "in_progress", diff: undefined } as TaskChatItem,
  workspaceChange(false),
];

/** Opens activity groups and the named rows, as if a reviewer had clicked them. */
class OpenRows extends Map<string, boolean> {
  constructor(private readonly rows: readonly string[]) { super(); }
  override get(id: string) {
    if (super.has(id)) return super.get(id);
    if (!id.startsWith("runner-detail:")) return true;
    return this.rows.includes(id.slice("runner-detail:".length));
  }
}

function Frame({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{rule}</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-4">{children}</div>
    </section>
  );
}

function AllStates() {
  const started = Date.now() - 94_000;
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
        <header>
          <h2 className="text-lg font-semibold">Inline edit diffs</h2>
          <p className="text-sm text-muted-foreground">
            Each file edit shows its line counts and opens to a compact diff. The turn ends with the files it changed
            and the whole-turn diff. Codex and Claude edits look the same.
          </p>
        </header>
        <Frame title="Finished turn" rule="Edit rows carry +/− counts. The changes card lists every file the turn touched.">
          <TaskChatExpansionState.Provider value={new OpenRows(["edit-1"])}>
          <TaskChatRunnerTurn
            runId="run-edit-diffs"
            agentName="CodexRunner"
            items={completedItems}
            status="succeeded"
            startedAtMs={started}
            finishedAtMs={started + 94_000}
          />
          </TaskChatExpansionState.Provider>
        </Frame>
        <Frame title="Running" rule="A file still being written has no counts yet. The card says changes are in progress.">
          <TaskChatRunnerTurn
            runId="run-edit-diffs-live"
            agentName="ClaudeRunner"
            items={runningItems}
            status="running"
            startedAtMs={started}
          />
        </Frame>
      </div>
    </div>
  );
}

const meta = {
  id: "tasks-task-chat-edit-diffs",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/Edit diffs",
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      implementation: "production",
      boundary: "fixtures",
      notes: "Production runner turn with fixture edit rows and a fixture workspace change set.",
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const EditDiffs: Story = {
  render: () => <AllStates />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [card] = await canvas.findAllByTestId("task-chat-workspace-change");
    const [firstFile] = within(card).getAllByTestId("task-chat-workspace-change-file");
    await userEvent.click(within(firstFile).getByRole("button"));
    await expect(within(firstFile).getByTestId("task-chat-diff-view")).toBeVisible();
  },
};
