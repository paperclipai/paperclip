import { expect, test } from "@playwright/test";
import { readBoundTaskFinalReply } from "./native-task-reply.js";

const markdown = "I **couldn't retrieve** the pages. See [Connection outcome](/QA/issues/QA-123#document-outcome).";
const rendered = "I <strong>couldn't retrieve</strong> the pages. See <a href='/QA/issues/QA-123#document-outcome'><svg aria-hidden='true'></svg>QA-123</a>.";
const run = { id: "final-run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "native",
  resultJson: { presentationDecision: { commentId: "selected" } } };
const comment = { id: "selected", authorAgentId: "agent", createdByRunId: run.id, body: markdown };

for (const [name, content, passes] of [
  ["decorated document link and bold text", rendered, true],
  ["wrong destination", rendered.replace("#document-outcome", "#document-other"), false],
  ["missing link", rendered.replace(/<a.*?<\/a>/, "QA-123"), false],
  ["extra visible text", rendered + " Extra.", false],
  ["hidden source text", rendered.replace("couldn't retrieve", "<span hidden>couldn't retrieve</span>"), false],
] as const) test(`reloaded task reply: ${name}`, async ({ page }) => {
  await page.route("https://fixture.test/task", route => route.fulfill({ contentType: "text/html", body:
    `<div data-testid='task-chat-thread'><div data-thread-anchor='selected'><div data-testid='task-chat-agent-bubble'>${content}</div></div></div>` }));
  await page.goto("https://fixture.test/task");
  const result = readBoundTaskFinalReply({ page, runId: run.id, agentId: "agent", deadlineAt: Date.now() + (passes ? 3000 : 300),
    load: async () => ({ run, comments: [comment], events: [] }) });
  if (passes) {
    const receipt = await result;
    expect(receipt.source).toBe("posted-comment");
    expect(receipt.sourceBody).toBe(markdown);
    expect(receipt.body).toBe("I couldn't retrieve the pages. See QA-123.");
    expect(receipt.observedAfterReload).toBe(true);
  } else await expect(result).rejects.toThrow();
});
