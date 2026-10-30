import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool } from "../services/project-tools.js";

const input = {
  name: "create_task", apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222", conversation: false,
};
const blockerId = "33333333-3333-4333-8333-333333333333";

afterEach(() => vi.unstubAllGlobals());

describe("project tool task backlog", () => {
  it.each([
    [{ status: "backlog" }, "backlog"],
    [{ status: "backlog", blockedByTaskIds: [blockerId] }, "backlog"],
    [{ status: "todo" }, "todo"],
    [{}, "todo"],
    [{ blockedByTaskIds: [blockerId] }, "blocked"],
    [{ status: "todo", blockedByTaskIds: [blockerId] }, "blocked"],
  ])("sends the requested status %j as %s", async (fields, expected) => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetch);
    await callProjectTool({ ...input, arguments: { title: "Task", idempotencyKey: "key", ...fields } });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({ status: expected });
  });
});
