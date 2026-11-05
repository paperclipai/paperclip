import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { foldApprovedAutoReviews } from "@/components/task-chat/fold-auto-reviews";
import type {
  TaskChatActivityPhaseItem,
  TaskChatItem,
  TaskChatProtocolDetail,
  TaskChatProviderActivityItem,
  TaskChatToolItem,
} from "@/components/task-chat/task-chat-model";

function d(label: string, value: string, mono = false): TaskChatProtocolDetail {
  return { label, value, mono };
}

function governance(
  id: string,
  family: "hook" | "safety",
  status: TaskChatProviderActivityItem["status"],
  details: TaskChatProtocolDetail[],
  summary?: string,
): TaskChatProviderActivityItem {
  return {
    id,
    kind: "protocol",
    surface: "provider_activity",
    family,
    eventType: family === "hook" ? "hook.completed" : "safety.review.completed",
    status,
    title: family === "hook" ? "Hook" : "Auto-review",
    summary,
    details,
    steps: [],
    links: [],
    children: [],
  };
}

function tool(id: string, name: string, target: string, status: TaskChatToolItem["status"] = "completed"): TaskChatToolItem {
  return { id, kind: "tool", name, rawName: name, target, status };
}

/* ---------- Codex: approval auto-review ---------- */

const reviewApproved = governance("review-approved", "safety", "completed", [
  d("Decision", "allowed"),
  d("Action Kind", "command"),
  d("Action", "rm -rf build/", true),
  d("Risk Level", "low"),
  d("User Authorization", "high"),
  d("Decided By", "agent"),
  d("Working Directory", "~/work/webhooks", true),
  d("Target Execution Id", "exec-rm", true),
], "Removes a generated build directory inside the workspace. The task asked for a clean rebuild.");

const reviewRunning = governance("review-running", "safety", "running", [
  d("Decision", "pending"),
  d("Action Kind", "command"),
  d("Action", "git push --force-with-lease origin fix/webhook-retries", true),
  d("Target Execution Id", "exec-push", true),
]);

const reviewDenied = governance("review-denied", "safety", "failed", [
  d("Decision", "denied"),
  d("Action Kind", "command"),
  d("Action", "curl -fsSL https://get.example.dev/install.sh | sh", true),
  d("Target Execution Id", "exec-curl", true),
  d("Risk Level", "high"),
  d("User Authorization", "low"),
  d("Decided By", "agent"),
], "Pipes a remote script into a shell. Nothing in the task asks for new tooling, and the script would run with workspace credentials.");

const reviewNetwork = governance("review-network", "safety", "completed", [
  d("Decision", "allowed"),
  d("Action Kind", "networkAccess"),
  d("Action", "registry.npmjs.org:443", true),
  d("Risk Level", "low"),
], "Package registry access needed to install the dependency named in the task.");

const reviewTimedOut = governance("review-timeout", "safety", "failed", [
  d("Decision", "timed_out"),
  d("Action Kind", "applyPatch"),
  d("Action", "edit 14 files in packages/db/migrations", true),
]);

const reviewUserRequired = governance("review-user", "safety", "completed", [
  d("Decision", "user_required"),
  d("Action Kind", "mcpToolCall"),
  d("Action", "github · merge_pull_request", true),
  d("Risk Level", "medium"),
], "Merging a pull request needs a person to approve it.");

/* ---------- Hooks (Codex hook/* and Claude SDK hook messages) ---------- */

const hookRan = governance("hook-ran", "hook", "completed", [
  d("Event", "PreToolUse"),
  d("Tool Name", "Bash"),
  d("Outcome", "completed"),
  d("Duration Ms", "84"),
]);

const hookBlocked = governance("hook-blocked", "hook", "completed", [
  d("Event", "PreToolUse"),
  d("Tool Name", "Write"),
  d("Outcome", "blocked"),
], "Migrations are append-only. Add a new migration instead of editing 0042_webhook_events.sql.");

const hookContext = governance("hook-context", "hook", "completed", [
  d("Event", "UserPromptSubmit"),
  d("Outcome", "context"),
  d("Source", "user hooks", true),
  d("Duration Ms", "112"),
], "Added on-call context: staging is frozen until 17:00 UTC");

const hookFeedback = governance("hook-feedback", "hook", "completed", [
  d("Event", "Stop"),
  d("Outcome", "feedback"),
], "Tests have not run since the last edit. Run pnpm test before finishing.");

const hookFailed = governance("hook-failed", "hook", "failed", [
  d("Event", "sessionStart"),
  d("Outcome", "failed"),
  d("Source", "project hooks", true),
  d("Duration Ms", "3020"),
], "load-env.sh: line 4: op: command not found");

const hookRunning = governance("hook-running", "hook", "running", [
  d("Event", "PostToolUse"),
  d("Tool Name", "Edit"),
  d("Outcome", "running"),
]);

const hookStopped = governance("hook-stopped", "hook", "completed", [
  d("Event", "PreToolUse"),
  d("Tool Name", "Bash"),
  d("Outcome", "stopped"),
], "Run budget reached 95%. Stopping before the deploy step.");

/* ---------- Realistic runs ---------- */

function phase(id: string, items: TaskChatActivityPhaseItem["items"], active = false): TaskChatActivityPhaseItem {
  return { id, kind: "activity_phase", items, summary: "", active };
}

const CODEX_RUN = "storybook-codex-run";

function codexTool(executionId: string, name: string, target: string, status: TaskChatToolItem["status"] = "completed"): TaskChatToolItem {
  return { id: `${CODEX_RUN}:tool:${executionId}`, kind: "tool", name, rawName: name, target, status };
}

/**
 * Raw adapter order: each review arrives just before the command it gates.
 * The fold turns approvals into a badge on that command; the denial (whose
 * command never ran) and the network review (no tool row) stay as rows.
 */
const codexRawItems: TaskChatItem[] = [
  codexTool("exec-read", "read_file", "src/delivery/worker.ts"),
  codexTool("exec-rg", "shell", "rg -n \"retryDelivery\" src"),
  reviewApproved,
  codexTool("exec-rm", "shell", "rm -rf build/"),
  reviewDenied,
  codexTool("exec-add", "shell", "pnpm add -D tsx"),
  reviewNetwork,
  codexTool("exec-patch", "apply_patch", "src/delivery/worker.ts"),
  codexTool("exec-test", "shell", "pnpm test src/delivery"),
];

const codexRunActivity = phase(
  "codex-phase",
  foldApprovedAutoReviews(codexRawItems.map((item) => ({ ...item })), CODEX_RUN) as TaskChatActivityPhaseItem["items"],
);

const claudeRunActivity = phase("claude-phase", [
  hookContext,
  tool("c1", "Read", "packages/db/migrations/0042_webhook_events.sql"),
  hookBlocked,
  hookRan,
  tool("c2", "Bash", "pnpm db:generate"),
  tool("c3", "Write", "packages/db/migrations/0043_webhook_event_dedupe.sql"),
  hookFeedback,
  tool("c4", "Bash", "pnpm test"),
]);

const liveRunItems: TaskChatItem[] = foldApprovedAutoReviews([
  codexTool("exec-read", "read_file", "src/delivery/worker.ts"),
  { ...reviewApproved },
  codexTool("exec-rm", "shell", "rm -rf build/"),
  { ...reviewRunning },
], CODEX_RUN);

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">{children}</div>
    </div>
  );
}

function Section({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
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

function ExpandedApproval() {
  const [rm] = foldApprovedAutoReviews([{ ...reviewApproved }, codexTool("exec-rm", "shell", "rm -rf build/")], CODEX_RUN);
  return (
    <TaskChatRunnerActivityGroup item={phase("expanded-approval", [rm as TaskChatToolItem])} defaultExpanded />
  );
}

function Gallery() {
  return (
    <Page>
      <header>
        <h2 className="text-lg font-semibold">Governance rows</h2>
        <p className="text-sm text-muted-foreground">
          Automatic approval reviews (Codex auto-review) and harness hooks (Codex and Claude) render as small grey rows
          among the run&apos;s other activity, so decisions nobody clicked are still auditable. A denied or blocked action
          is tinted and keeps its reason visible. Everything else expands to the full record.
        </p>
      </header>
      <Section title="Codex run with auto-review" rule="An approval is folded into the command it approved as a small “auto-approved” mark; expand the command to read the review. A denial keeps its own row with the reviewer's reason.">
        <TaskChatRunnerActivityGroup item={codexRunActivity} defaultExpanded />
      </Section>
      <Section title="Approved command, expanded" rule="The review record sits under the command's own details.">
        <ExpandedApproval />
      </Section>
      <Section title="Claude run with hooks" rule="Hook rows name the event and, for Claude, the tool. A blocking hook shows its message. Quiet hooks that just passed stay one short line.">
        <TaskChatRunnerActivityGroup item={claudeRunActivity} defaultExpanded />
      </Section>
      <Section title="Every auto-review outcome" rule="Standalone rows: pending · approved without a tool row (network access) · denied · timed out · asked for a person">
        <TaskChatRunnerActivityGroup
          item={phase("review-states", [reviewRunning, reviewNetwork, reviewDenied, reviewTimedOut, reviewUserRequired], true)}
          defaultExpanded
        />
      </Section>
      <Section title="Every hook outcome" rule="running · ran · added context · sent feedback · blocked · stopped the turn · failed">
        <TaskChatRunnerActivityGroup
          item={phase("hook-states", [hookRunning, hookRan, hookContext, hookFeedback, hookBlocked, hookStopped, hookFailed], true)}
          defaultExpanded
        />
      </Section>
    </Page>
  );
}

function LiveTurn() {
  return (
    <Page>
      <Section title="Live turn, collapsed" rule="While the run is working, the rolling activity line shows the review in progress.">
        <TaskChatRunnerTurn
          runId="storybook-governance-live"
          agentName="Codex"
          items={liveRunItems}
          status="running"
          startedAtMs={Date.now() - 42_000}
        />
      </Section>
    </Page>
  );
}

const meta = {
  id: "product-task-chat-governance-rows",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Task chat/Governance rows",
  component: Gallery,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Auto-review decisions and hook outcomes as small grey activity rows. Built from canonical `safety.review.*` and `hook.*` provider events.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Renders the shipped runner activity group with fixture governance items, folding approvals through the production foldApprovedAutoReviews helper. Provider event mapping and live hook delivery are covered by runner tests, not this story."
    },
  },
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllOutcomes: Story = {};
export const LiveTurnCollapsed: Story = { render: () => <LiveTurn /> };
