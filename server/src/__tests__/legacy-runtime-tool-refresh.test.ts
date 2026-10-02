import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// Pi resolves its session directory at module load. Keep that test directory
// under the temporary root instead of the operator's real home.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual.default, homedir: actual.tmpdir }, homedir: actual.tmpdir };
});
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute as gemini } from "@paperclipai/adapter-gemini-local/server";
import { execute as kimi } from "@paperclipai/adapter-kimi-local/server";
import { execute as cursor } from "@paperclipai/adapter-cursor-local/server";
import { execute as opencode } from "@paperclipai/adapter-opencode-local/server";
import { execute as pi } from "@paperclipai/adapter-pi-local/server";

const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("legacy environment tool access on resumed conversations", () => {
  it.each([
    ["gemini_local", gemini, "--resume"], ["kimi_local", kimi, "-r"],
    ["cursor", cursor, "--resume"], ["opencode_local", opencode, "--session"], ["pi_local", pi, "--session"],
  ] as const)("refreshes %s without dropping its conversation", async (type, execute, resumeFlag) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cli-tool-refresh-")); roots.push(root);
    const command = path.join(root, "agent");
    await fs.writeFile(command, "#!/bin/sh\nprintf 'provider  model\\nopenai  gpt-5\\n'\n", { mode: 0o755 });
    const sessionId = type === "pi_local" ? path.join(root, "session.jsonl") : "existing-session";
    if (type === "pi_local") await fs.writeFile(sessionId, JSON.stringify({ type: "session", cwd: root }) + "\n");
    const stdout = type === "kimi_local"
      ? JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sessionId })
      : type === "opencode_local"
        ? JSON.stringify({ type: "text", sessionID: sessionId, part: { text: "done" } })
        : type === "pi_local"
          ? JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: "done" }] })
          : JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: "done" });
    const invocations: Array<{ args: string[]; env: Record<string, string> }> = [];
    vi.mocked(runAdapterExecutionTargetProcess).mockImplementation(async (_runId, _target, _command, args, options) => {
      invocations.push({ args, env: options.env ?? {} });
      return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: null, startedAt: null };
    });
    const ctx: AdapterExecutionContext = {
      runId: "refresh", agent: { id: "agent", companyId: "company", name: "Agent", adapterType: type, adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: root }, sessionDisplayId: sessionId, taskKey: null },
      config: { command, cwd: root, model: "openai/gpt-5", engine: "cli", env: { HOME: root, XDG_CONFIG_HOME: root, OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: { refreshTools: true, paperclipFreshSessionHandoffMarkdown: "FRESH_HANDOFF_ONLY" }, onLog: async () => {},
      runtimeTools: { version: 1, guidance: "Tools available", mcpEndpoint: "https://example.test/current-tools/mcp",
        rest: { connectionsSearch: "https://example.test/search", connectionRequest: "https://example.test/request" },
        bearerToken: "current-tool-token", expiresAt: "2027-01-01T00:00:00Z", tools: ["connections_search", "connection_request"] },
    };
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    const invocation = invocations.at(-1)!;
    expect(invocation.args[invocation.args.indexOf(resumeFlag) + 1]).toBe(sessionId);
    expect(invocation.env.PAPERCLIP_RUNTIME_TOOLS_MCP_URL).toBe(ctx.runtimeTools!.mcpEndpoint);
    expect(invocation.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("current-tool-token");
    expect(invocation.args.join(" ")).not.toContain("FRESH_HANDOFF_ONLY");
    expect(result.sessionParams?.sessionId).toBe(sessionId);
    // Revocation likewise gets the current environment on the same session.
    await execute({ ...ctx, runtimeTools: undefined });
    expect(invocations.at(-1)!.env.PAPERCLIP_RUNTIME_TOOLS_MCP_URL).toBeUndefined();
  });
});
