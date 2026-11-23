import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBoundTaskFinalReply } from "./native-task-reply.js";

const markdown = "I **couldn't retrieve** the pages. See [Connection outcome](/QA/issues/QA-123#document-outcome).";
const rendered = "I <strong>couldn't retrieve</strong> the pages. See <a data-mention-kind='issue' href='/QA/issues/QA-123#document-outcome'><svg aria-hidden='true'></svg>QA-123</a>.";
const run = { id: "final-run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "native",
  resultJson: { presentationDecision: { commentId: "selected" } } };
const comment = { id: "selected", authorAgentId: "agent", createdByRunId: run.id, body: markdown };

test("the QA tsx loader produces a self-contained browser callback", async ({ page }) => {
  const moduleUrl = new URL("./native-task-reply.ts", import.meta.url).href;
  const loader = fileURLToPath(new URL("../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url));
  const serialized = JSON.parse(execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e",
    `import { observeTaskReplyElements } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(observeTaskReplyElements.toString()));`], { encoding: "utf8" }));
  await page.setContent(`<div data-testid='reply'>${rendered}</div>`);
  const observations: any = await page.evaluate(`(${serialized})(Array.from(document.querySelectorAll('[data-testid="reply"]')))`);
  expect(observations[0].body).toBe("I couldn't retrieve the pages. See QA-123.");
  expect(observations[0].content.some((part: any) => part.label === "QA-123" && part.decorated)).toBe(true);
});

for (const [source, html, passes] of [
  ["Depends on QA-123.", "Depends on <a data-mention-kind='issue' href='/QA/issues/QA-123'>QA-123</a>.", true],
  ["See https://example.com/", "See <a href='https://example.com/'>https://example.com/</a>", true],
  ["Depends on TREE-604.", "Depends on TREE-604.", true],
  ["Depends on QA-123.", "Depends on <a data-mention-kind='issue' href='/QA/issues/QA-999'>QA-123</a>.", false],
  ["See https://example.com/", "See <a href='https://other.test/'>https://example.com/</a>", false],
  ["- [x] Finished\n- [ ] Next", "<ul><li><input type='checkbox' checked disabled> Finished</li><li><input type='checkbox' disabled> Next</li></ul>", true],
  ["- [x] Finished\n- [ ] Next", "<ul><li><input type='checkbox' disabled> Finished</li><li><input type='checkbox' disabled> Next</li></ul>", false],
] as const) test(`reloaded auto-linked content: ${source} (${passes})`, async ({ page }) => {
  const url = "https://fixture.test/QA/issues/QA-1";
  await page.route(url, route => route.fulfill({ contentType: "text/html", body:
    `<div data-testid='task-chat-thread'><div data-thread-anchor='selected'><div data-testid='task-chat-agent-bubble'>${html}</div></div></div>` }));
  await page.goto(url);
  const result = readBoundTaskFinalReply({ page, runId: run.id, agentId: "agent", knownCompanyPrefixes: ["QA"], deadlineAt: Date.now() + (passes ? 3000 : 300),
    load: async () => ({ run, comments: [{ ...comment, body: source }], events: [] }) });
  if (passes) expect((await result).sourceBody).toBe(source);
  else await expect(result).rejects.toThrow();
});

for (const [name, content, passes] of [
  ["decorated document link and bold text", rendered, true],
  ["ordinary link with its source label", rendered.replace(" data-mention-kind='issue'", "").replace(">QA-123</a>", ">Connection outcome</a>"), true],
  ["renamed ordinary link", rendered.replace(" data-mention-kind='issue'", ""), false],
  ["wrong destination", rendered.replace("#document-outcome", "#document-other"), false],
  ["missing link", rendered.replace(/<a.*?<\/a>/, "QA-123"), false],
  ["extra visible text", rendered + " Extra.", false],
  ["hidden source text", rendered.replace("couldn't retrieve", "<span hidden>couldn't retrieve</span>"), false],
] as const) test(`reloaded task reply: ${name}`, async ({ page }) => {
  await page.route("https://fixture.test/QA/issues/QA-123", route => route.fulfill({ contentType: "text/html", body:
    `<div data-testid='task-chat-thread'><div data-thread-anchor='selected'><div data-testid='task-chat-agent-bubble'>${content}</div></div></div>` }));
  await page.goto("https://fixture.test/QA/issues/QA-123");
  const result = readBoundTaskFinalReply({ page, runId: run.id, agentId: "agent", knownCompanyPrefixes: ["QA"], deadlineAt: Date.now() + (passes ? 3000 : 300),
    load: async () => ({ run, comments: [comment], events: [] }) });
  if (passes) {
    const receipt = await result;
    expect(receipt.source).toBe("posted-comment");
    expect(receipt.sourceBody).toBe(markdown);
    expect(receipt.body).toBe(content.includes(">Connection outcome</a>") ? "I couldn't retrieve the pages. See Connection outcome." : "I couldn't retrieve the pages. See QA-123.");
    expect(receipt.observedAfterReload).toBe(true);
  } else await expect(result).rejects.toThrow();
});

for (const [sourceHref, renderedHref, passes] of [
  ["/issues/QA-123#document-outcome", "/QA/issues/QA-123#document-outcome", true],
  ["#document-outcome", "/QA/issues/QA-123#document-outcome", true],
  ["/issues/QA-123#document-outcome", "/OTHER/issues/QA-123#document-outcome", false],
  ["#document-outcome", "/QA/issues/QA-999#document-outcome", false],
  ["/projects/example", "/projects/example", true],
  ["/projects/example", "/QA/projects/example", false],
] as const) test(`reloaded link ${sourceHref} to ${renderedHref}`, async ({ page }) => {
  const url = "https://fixture.test/QA/issues/QA-123";
  await page.route(url, route => route.fulfill({ contentType: "text/html", body:
    `<div data-testid='task-chat-thread'><div data-thread-anchor='selected'><div data-testid='task-chat-agent-bubble'>Read <a href='${renderedHref}'>Outcome</a></div></div></div>` }));
  await page.goto(url);
  const result = readBoundTaskFinalReply({ page, runId: run.id, agentId: "agent", knownCompanyPrefixes: ["QA"], deadlineAt: Date.now() + (passes ? 3000 : 300),
    load: async () => ({ run, comments: [{ ...comment, body: `Read [Outcome](${sourceHref})` }], events: [] }) });
  if (passes) expect((await result).pageUrl).toBe(url);
  else await expect(result).rejects.toThrow();
});
