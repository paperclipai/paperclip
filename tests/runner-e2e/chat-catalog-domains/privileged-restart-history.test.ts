import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const fixture = vi.hoisted(() => ({ log: "", receipt: {} }));
vi.mock("node:fs/promises", async original => ({ ...await original<object>(), readFile: async (file: string) => file.endsWith("server.log") ? fixture.log : JSON.stringify(fixture.receipt) }));
vi.mock("./privileged-support.js", async original => ({ ...await original<object>(), settlePrivilegedChat: async () => ({ runs: [{ id: "run" }] }) }));
vi.mock("@playwright/test", () => ({ expect: (node: { text: string; visible: boolean }) => ({
  toBeVisible: async () => expect(node.visible).toBe(true),
  toContainText: async (text: string) => expect(node.text).toContain(text),
  toHaveText: async (text: string, options: unknown) => { expect(options).toEqual({ useInnerText: true }); expect(node.text).toBe(text); },
}) }));
import { privilegedInstanceCases, gradeRestartService } from "./privileged-instance.js";
afterEach(() => vi.unstubAllEnvs());
const rendered = "Restart the service.\n\nHistory stays intact.";
async function run(afterText = rendered, beforeText = rendered, afterVisible = true, changedStoredBody = false) {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", "/tmp/owned-restart-history");
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_SERVER_LOG", "/tmp/owned-restart-history/server.log");
  fixture.log = ""; fixture.receipt = {};
  let restarted = false;
  const body = { text: beforeText, visible: true, innerText: vi.fn(async () => { expect(restarted).toBe(false); return body.text; }), first: () => body };
  const comment = { id: "reply", authorAgentId: "lead", body: "**Restart** the service.\n\nHistory stays `intact`.", createdByRunId: "run" };
  const ctx = { input: { nonce: "nonce", fixtures: { agent: { id: "lead" } },
    api: { get: async () => [{ ...comment, ...(restarted && changedStoredBody ? { body: "Changed persisted reply" } : {}) }] },
    page: { url: () => "https://fixture.test/RUN/chats/lead", goto: async () => {}, getByTestId: () => ({ visible: true }),
      locator: (selector: string) => { expect(selector).toBe('[id="comment-reply"]'); return { get text() { return "CEO" + body.text + "10:00 AM"; }, visible: true, locator: (nested: string) => { expect(nested).toBe(".paperclip-markdown"); return body; } }; } },
    restart: async () => { restarted = true; body.text = afterText; body.visible = afterVisible;
      fixture.log = "Restart request chat-nonce: stopping Paperclip\nRestart request chat-nonce: starting Paperclip\nRestart request chat-nonce: Paperclip is healthy";
      fixture.receipt = { requestId: "chat-nonce", status: "ready", completedAt: new Date().toISOString() }; }, evidence: vi.fn(),
  }, issue: () => ({ id: "source" }), refreshIssue: async () => {} } as unknown as ChatCatalogContext;
  const state: Record<string, unknown> = {};
  await privilegedInstanceCases[0]!.act!(ctx, state);
  expect(body.innerText).toHaveBeenCalledTimes(1);
  return state;
}
it("checks the same attributed rendered body across restart while preserving raw Markdown separately", async () => {
  expect(await run()).toMatchObject({ persistedHistoryRetained: true, browserHistoryVisible: true, stopStartLogVerified: true });
});
it.each(["Changed visible reply", ""])("rejects changed or missing rendered history: %j", async text => {
  await expect(run(text)).rejects.toThrow();
});
it("requires a visible nonempty body before restart and a visible body afterward", async () => {
  await expect(run(rendered, "")).rejects.toThrow(/no visible/);
  await expect(run(rendered, rendered, false)).rejects.toThrow();
});
it("keeps independently changed persisted bytes failing despite unchanged rendered text", async () => {
  const state = await run(rendered, rendered, true, true);
  expect(state).toMatchObject({ persistedHistoryRetained: false, browserHistoryVisible: true });
  expect(gradeRestartService({ state, origin: "https://fixture.test", companyId: "company", leadId: "lead", reply: "The operator should restart the server.",
    tasks: [], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: [], runs: [{ id: "run", status: "succeeded" }] }).passed).toBe(false);
});
