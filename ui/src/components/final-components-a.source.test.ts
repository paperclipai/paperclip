import fs from "node:fs";
import { expect, it } from "vitest";

it("maps workspace close actions by closed action kind, not by server text", () => {
  const source = fs.readFileSync(new URL("ExecutionWorkspaceCloseDialog.tsx", import.meta.url), "utf8");
  expect(source).toContain('final-components-a:closeAction_${action.kind}_label');
  expect(source).toContain('defaultValue: action.label');
});

it("routes editor-owned menus and accessibility messages through stable keys", () => {
  const source = fs.readFileSync(new URL("MarkdownEditor.tsx", import.meta.url), "utf8");
  expect(source).toContain('t(`final-components-a:editor_${key.replaceAll(".", "_")}`');
});

it("does not pass reachable numeric zero as a Trans child component", () => {
  for (const [file, expression] of [
    ["CodexSubscriptionPanel.tsx", "window.usedPercent"],
    ["ProjectWorkspaceSummaryCard.tsx", "summary.runningServiceCount"],
    ["SubscriptionCostCard.tsx", "report.activeCount"],
    ["RunnerInspector.tsx", "event.seq"],
    ["task-chat/TaskChatCompactInteractionCard.tsx", "selected.size"],
  ]) {
    const source = fs.readFileSync(new URL(file!, import.meta.url), "utf8");
    expect(source, `${file}: ${expression}`).not.toContain(`<>${"{"}${expression}${"}"}</>`);
  }
});
