import { describe, it, expect, vi } from "vitest";
import { dispatchTool } from "../src/server/tool-executor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("dispatchTool", () => {
  it("routes paperclip_* tools to paperclip-tools handler", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "agent-1", name: "CEO" }),
    }));

    const result = await dispatchTool({
      name: "paperclip_get_identity",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {
        apiUrl: "http://localhost:3100",
        authToken: "t",
        runId: "r",
        agentId: "a",
        companyId: "c",
      },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("CEO");
  });

  it("routes fs_* tools to fs-tools handler", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "dispatch-test-"));
    try {
      const result = await dispatchTool({
        name: "fs_write_file",
        args: { path: "a.txt", content: "hello" },
        cwd,
        paperclipCtx: {
          apiUrl: "", authToken: "", runId: "", agentId: "", companyId: "",
        },
      });
      expect(result.isError).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns error for unknown tool", async () => {
    const result = await dispatchTool({
      name: "unknown_tool",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {
        apiUrl: "", authToken: "", runId: "", agentId: "", companyId: "",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});
