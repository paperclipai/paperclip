import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool } from "../services/project-tools.js";

const input = {
  name: "create_task", apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project tool task status", () => {
  it.each(["done", "in_progress", "blocked"])("rejects the unsupported status %s before fetching", async (status) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, arguments: { title: "Task", idempotencyKey: "key", status } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
