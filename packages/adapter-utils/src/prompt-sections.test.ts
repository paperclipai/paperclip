import { describe, expect, it } from "vitest";
import { selectPaperclipPromptSections as selectSections } from "./server-utils.js";
import { createPromptContextFixture } from "./test-fixtures/prompt-context.js";

describe("task and event section ownership", () => {
  it("lets a separate instruction carrier own the execution contract on a resumed turn", () => {
    const context = createPromptContextFixture();
    const sections = selectSections(context, { resumedSession: true, includeExecutionContract: false });
    expect(sections.taskContextNote).toBe(context.paperclipTaskMarkdownAssignmentCompact);
    expect(sections.wakePrompt).toContain('"id":"comment-second"');
    expect(sections.wakePrompt).not.toContain("Execution contract:");
    expect(selectSections(context, { resumedSession: true }).wakePrompt).toContain("Execution contract:");
  });

  it("preserves user repetition and distinct same-body comments under their source owners", () => {
    const context = createPromptContextFixture();
    const { taskContextNote, wakePrompt } = selectSections(context);
    expect(taskContextNote).toContain(context.paperclipTaskMarkdownAssignment);
    expect(taskContextNote).toContain(context.paperclipWake.issue.description);
    expect(taskContextNote).not.toContain("comment-first");
    expect(wakePrompt).not.toContain(context.paperclipWake.issue.description);
    expect(wakePrompt).not.toContain('"objective":');
    expect(wakePrompt).toContain('"objectiveSource":{"kind":"description","id":"issue-1"');
    for (const message of context.executionContinuation.messages) {
      expect(wakePrompt).toContain(`"id":"${message.id}"`);
      expect(wakePrompt).toContain(message.body);
    }
    expect(wakePrompt.indexOf('"id":"comment-first"')).toBeLessThan(wakePrompt.indexOf('"id":"comment-second"'));
    expect(wakePrompt.indexOf('"id":"comment-second"')).toBeLessThan(wakePrompt.indexOf('"id":"comment-scope"'));
    expect(wakePrompt).toContain('"sourceTrust":"human"');
    expect(wakePrompt).toContain("Untrusted continuation evidence");
    expect(wakePrompt).toContain("receipt-1");
    expect(wakePrompt).toContain("Do not repeat completed actions");
  });

  it("reselects full bootstrap and history when the attempt becomes fresh", () => {
    const context = createPromptContextFixture();
    const resumed = selectSections(context, { resumedSession: true });
    expect(resumed.taskContextNote).toBe(context.paperclipTaskMarkdownAssignmentCompact);
    expect(resumed.wakePrompt).not.toContain('"id":"comment-first"');
    const fresh = selectSections(context, { resumedSession: false });
    expect(fresh.taskContextNote).toContain(context.paperclipTaskCommunicationGuidance);
    expect(fresh.taskContextNote).toContain(context.paperclipTaskMarkdownAssignment);
    expect(fresh.wakePrompt).toContain('"id":"comment-first"');
    expect(context.executionContinuation.messages).toHaveLength(3);
  });

  it("retains old input fields and the wake description when no assignment was provided", () => {
    const context = createPromptContextFixture();
    expect(selectSections({ paperclipTaskMarkdown: "Legacy assignment" }).taskContextNote).toBe("Legacy assignment");
    const sections = selectSections({ paperclipWake: context.paperclipWake });
    expect(sections.taskContextNote).toBe("");
    expect(sections.wakePrompt).toContain(context.paperclipWake.issue.description);
  });
});
