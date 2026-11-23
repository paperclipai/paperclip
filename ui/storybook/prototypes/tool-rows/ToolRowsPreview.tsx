import type { ReactNode } from "react";
import type {
  TaskChatActivityPhaseItem,
  TaskChatMessageItem,
  TaskChatToolItem,
} from "@/components/task-chat/task-chat-model";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";

type Tool = TaskChatToolItem;
const tool = (id: string, fields: Partial<Tool> & Pick<Tool, "name">): Tool => ({
  kind: "tool",
  id,
  status: "completed",
  ...fields,
});

function message(id: string, text: string): TaskChatMessageItem {
  return { id, kind: "message", author: "agent", text };
}

function phase(id: string, items: TaskChatActivityPhaseItem["items"], text?: string, active = false): TaskChatActivityPhaseItem {
  return {
    id,
    kind: "activity_phase",
    items,
    active,
    summary: "",
    ...(text ? { interstitial: message(`${id}:message`, text) } : {}),
  };
}

/**
 * The same Claude calls as the runner records them today: the first ACP title
 * sticks ("Terminal", "Preparing file…"), absolute Read paths are dropped, and
 * there is no exit code or duration. Historical runs keep rendering this way.
 */
const claudeToday = phase("claude-today", [
  tool("c1", { name: "Read", rawName: "Read", operation: "read" }),
  tool("c2", { name: "Read", rawName: "Read", operation: "read" }),
  tool("c3", { name: "Read", rawName: "Read", operation: "read" }),
  tool("c4", { name: "Preparing file…", rawName: "Preparing file…", operation: "edit" }),
  tool("c5", { name: "Terminal", rawName: "Terminal", operation: "execute", status: "failed", detail: "not ok 2 - converts negative temperatures" }),
  tool("c6", { name: "Edit", rawName: "Edit", operation: "edit" }),
  tool("c7", { name: "Terminal", rawName: "Terminal", operation: "execute" }),
  tool("c8", { name: "Terminal", rawName: "Terminal", operation: "execute", status: "failed", detail: "Permission to use Bash with command rm -rf node_modules has been denied." }),
], "I'll add the conversion helper, then run the tests.");

/** The same Claude run with real names, subjects, outcomes and a folded read run. */
const claudeProposed = phase("claude-proposed", [
  tool("p1", { name: "Read", rawName: "Read", operation: "read", target: "README.md", durationMs: 40 }),
  tool("p2", { name: "Read", rawName: "Read", operation: "read", target: "package.json", durationMs: 31 }),
  tool("p3", { name: "Read", rawName: "Read", operation: "read", target: "src/temp.js", durationMs: 38 }),
  tool("p4", { name: "Write", rawName: "Write", operation: "edit", target: "src/convert.js", durationMs: 112, diff: { path: "src/convert.js", added: 24, removed: 0 } }),
  tool("p5", {
    name: "Bash", rawName: "Bash", operation: "execute", target: "node --test", description: "Run the unit tests",
    status: "failed", exitCode: 1, durationMs: 1_840, detail: "not ok 2 - converts negative temperatures\n# tests 6\n# pass 5\n# fail 1",
  }),
  tool("p6", { name: "Edit", rawName: "Edit", operation: "edit", target: "src/convert.js", durationMs: 96, diff: { path: "src/convert.js", added: 2, removed: 1 } }),
  tool("p7", { name: "Bash", rawName: "Bash", operation: "execute", target: "node --test", description: "Run the unit tests again", exitCode: 0, durationMs: 1_620, detail: "# tests 6\n# pass 6" }),
  tool("p8", {
    name: "Bash", rawName: "Bash", operation: "execute", target: "rm -rf node_modules", status: "failed",
    blockedReason: "Permission denied by the workspace policy",
  }),
], "I'll add the conversion helper, then run the tests.");

/** A Codex run: commandActions already classify reads and searches. */
const codexToday = phase("codex-today", [
  tool("x1", { name: "Bash", rawName: "Bash", target: "/bin/zsh -lc 'sed -n 1,120p src/server.ts'", exitCode: 0, durationMs: 31 }),
  tool("x2", { name: "Bash", rawName: "Bash", target: "/bin/zsh -lc 'sed -n 1,80p src/routes.ts'", exitCode: 0, durationMs: 24 }),
  tool("x3", { name: "Bash", rawName: "Bash", target: "/bin/zsh -lc 'cat src/db.ts'", exitCode: 0, durationMs: 19 }),
  tool("x4", { name: "Bash", rawName: "Bash", target: "/bin/zsh -lc 'cat test/server.test.ts'", exitCode: 0, durationMs: 20 }),
  tool("x5", { name: "Bash", rawName: "Bash", target: "/bin/zsh -lc 'rg -n \"TODO\" src'", exitCode: 0, durationMs: 52 }),
  tool("x6", { name: "Bash", rawName: "Bash", target: "/bin/zsh -lc 'pnpm vitest run test/server.test.ts'", exitCode: 0, durationMs: 14310 }),
], "Reading the server before changing the handler.");

const codexProposed = phase("codex-proposed", [
  tool("y1", { name: "Read", rawName: "Read", operation: "read", target: "src/server.ts", exitCode: 0, durationMs: 22 }),
  tool("y2", { name: "Read", rawName: "Read", operation: "read", target: "src/routes.ts", exitCode: 0, durationMs: 19 }),
  tool("y3", { name: "Read", rawName: "Read", operation: "read", target: "src/db.ts", exitCode: 0, durationMs: 17 }),
  tool("y4", { name: "Read", rawName: "Read", operation: "read", target: "test/server.test.ts", exitCode: 0, durationMs: 18 }),
  tool("y5", { name: "Grep", rawName: "Grep", operation: "search", target: "\"TODO\" in src", exitCode: 0, durationMs: 48 }),
  tool("y6", { name: "Bash", rawName: "Bash", operation: "execute", target: "pnpm vitest run test/server.test.ts", exitCode: 0, durationMs: 14_200, detail: "✓ test/server.test.ts (9 tests) 1.31s" }),
], "Reading the server before changing the handler.");

const liveClaude = phase("live-claude", [
  ...claudeProposed.items.slice(0, 4),
  tool("live", { name: "Bash", rawName: "Bash", operation: "execute", target: "node --test", description: "Run the unit tests", status: "in_progress" }),
], undefined, true);

function Column({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-4">{children}</div>
    </section>
  );
}

export function ToolRowsPreview({ mode = "compare", narrow = false }: { mode?: "compare" | "live" | "proposed"; narrow?: boolean }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className={narrow ? "mx-auto flex w-full max-w-sm flex-col gap-8" : "mx-auto flex w-full max-w-5xl flex-col gap-8"}>
        <header>
          <h2 className="text-lg font-semibold">Tool rows that say what ran and how it went</h2>
          <p className="text-sm text-muted-foreground">
            One row grammar for Claude and Codex: verb icon, the real subject, an exit chip and the duration.
            Three or more reads in a row fold into one line. A refused tool says why.
          </p>
        </header>
        {mode === "live" ? (
          <Column title="Live, collapsed" note="The rolling line shows the command while it runs. Outcome chips appear when it ends.">
            <TaskChatRunnerActivityGroup item={liveClaude} />
          </Column>
        ) : null}
        {mode === "proposed" ? (
          <Column title="Claude, proposed" note="Expanded history.">
            <TaskChatRunnerActivityGroup item={claudeProposed} defaultExpanded />
          </Column>
        ) : null}
        {mode === "compare" ? (
          <>
            <div className={narrow ? "flex flex-col gap-6" : "flex gap-6"}>
              <Column title="Claude, data recorded today" note="First ACP titles stick (“Terminal”, “Preparing file…”). No command, no exit code, no duration; a denial looks like any failure. Old runs keep rendering like this.">
                <TaskChatRunnerActivityGroup item={claudeToday} defaultExpanded />
              </Column>
              <Column title="Claude, new runner data" note="Tool name from _meta.claudeCode, subject from rawInput, exit from the result, duration measured by the runner.">
                <TaskChatRunnerActivityGroup item={claudeProposed} defaultExpanded />
              </Column>
            </div>
            <div className={narrow ? "flex flex-col gap-6" : "flex gap-6"}>
              <Column title="Codex, data recorded today" note="Codex already records exit code and duration; the shell wrapper hides what the command did.">
                <TaskChatRunnerActivityGroup item={codexToday} defaultExpanded />
              </Column>
              <Column title="Codex, new runner data" note="commandActions turn sed/cat into reads and rg into a search; the wrapper is dropped.">
                <TaskChatRunnerActivityGroup item={codexProposed} defaultExpanded />
              </Column>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
