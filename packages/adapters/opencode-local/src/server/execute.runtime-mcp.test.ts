import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "opencode"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    ensureOpenCodeModelConfiguredAndAvailable: vi.fn(async () => undefined),
  };
});

import { execute } from "./execute.js";

const cleanup: Array<() => Promise<void>> = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  vi.clearAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await Promise.allSettled(cleanup.splice(0).map((entry) => entry()));
});

async function makeRuntimeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-runtime-mcp-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const sourceConfigHome = path.join(root, "source-config");
  await fs.mkdir(path.join(sourceConfigHome, "opencode"), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(sourceConfigHome, "opencode", "opencode.json"),
    `${JSON.stringify({ mcp: { inherited: { type: "remote", url: "https://inherited.example.test/mcp" } } })}\n`,
  );
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = sourceConfigHome;
  return { root, home, workspace, sourceConfigHome };
}

function executionContext(input: {
  workspace: string;
  sourceConfigHome: string;
  token: string;
  upstreamUrl?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: AdapterExecutionContext["onMeta"];
}): AdapterExecutionContext {
  return {
    runId: "run-local-mcp",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode Builder",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "opencode",
      model: "opencode/gpt-5-nano",
      env: { XDG_CONFIG_HOME: input.sourceConfigHome },
    },
    context: { issueId: "issue-1", paperclipWorkspace: { cwd: input.workspace } },
    runtimeMcp: {
      getServers: () => [{
        name: "Exact Gateway",
        connectionId: "gateway-1",
        url: input.upstreamUrl ?? "http://127.0.0.1:9/upstream-placeholder",
        token: input.token,
      }],
    },
    onLog: input.onLog ?? (async () => {}),
    onMeta: input.onMeta,
  };
}

describe("OpenCode confidential runtime MCP execution", () => {
  it("keeps the bearer out of config, process inputs, metadata, session state, and logs", async () => {
    const fixture = await makeRuntimeFixture();
    const token = "synthetic-confidential-run-token";
    let upstreamAuthorization: string | undefined;
    const upstream = http.createServer(async (request, response) => {
      upstreamAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("fixture did not bind");

    let runtimeConfigPath = "";
    let runtimeConfigRaw = "";
    let relayUrl = "";
    let processInput: unknown = null;
    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      args: string[],
      options: { env: Record<string, string>; stdin?: string },
    ) => {
      runtimeConfigPath = path.join(options.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
      runtimeConfigRaw = await fs.readFile(runtimeConfigPath, "utf8");
      const runtimeConfig = JSON.parse(runtimeConfigRaw) as {
        mcp: Record<string, { url: string }>;
      };
      relayUrl = Object.values(runtimeConfig.mcp)[0]!.url;
      processInput = { args, env: options.env, stdin: options.stdin };
      const relayResponse = await fetch(relayUrl, {
        method: "POST",
        headers: { authorization: "Bearer caller-controlled", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(relayResponse.status).toBe(200);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "step_start", sessionID: "session-local" }),
          JSON.stringify({ type: "step_finish", sessionID: "session-local", part: { cost: 0, tokens: {} } }),
        ].join("\n"),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });
    const logs: string[] = [];
    let invocationMeta: AdapterInvocationMeta | null = null;
    const context = executionContext({
      workspace: fixture.workspace,
      sourceConfigHome: fixture.sourceConfigHome,
      token,
      upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}/mcp`,
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      onMeta: async (meta) => { invocationMeta = meta; },
    });

    const result = await execute(context);

    expect(upstreamAuthorization).toBe(`Bearer ${token}`);
    expect(runtimeConfigRaw).toContain(relayUrl);
    expect(runtimeConfigRaw).not.toContain(token);
    expect(runtimeConfigRaw).not.toContain(upstreamAddress.port.toString());
    expect(runtimeConfigRaw).not.toContain("inherited.example.test");
    expect(JSON.stringify(processInput)).not.toContain(token);
    expect(JSON.stringify(invocationMeta)).not.toContain(token);
    expect(JSON.stringify(invocationMeta)).not.toContain(relayUrl);
    expect(JSON.stringify(result.sessionParams)).not.toContain(token);
    expect(JSON.stringify(result.resultJson)).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
    await expect(fs.access(path.dirname(path.dirname(runtimeConfigPath)))).rejects.toThrow();
    await expect(fetch(relayUrl)).rejects.toThrow();
  });

  it.each(["error", "cancelled"] as const)(
    "removes config and stops relays after a %s process outcome",
    async (outcome) => {
      const fixture = await makeRuntimeFixture();
      const token = `synthetic-${outcome}-token`;
      let runtimeConfigHome = "";
      let relayUrl = "";
      runAdapterExecutionTargetProcess.mockImplementation(async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        options: { env: Record<string, string> },
      ) => {
        runtimeConfigHome = options.env.XDG_CONFIG_HOME;
        const runtimeConfig = JSON.parse(
          await fs.readFile(path.join(runtimeConfigHome, "opencode", "opencode.json"), "utf8"),
        ) as { mcp: Record<string, { url: string }> };
        relayUrl = Object.values(runtimeConfig.mcp)[0]!.url;
        if (outcome === "error") throw new Error("synthetic process failure");
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          stdout: "",
          stderr: "cancelled",
          pid: 124,
          startedAt: new Date().toISOString(),
        };
      });
      const context = executionContext({
        workspace: fixture.workspace,
        sourceConfigHome: fixture.sourceConfigHome,
        token,
      });

      if (outcome === "error") {
        await expect(execute(context)).rejects.toThrow("synthetic process failure");
      } else {
        await expect(execute(context)).resolves.toMatchObject({ signal: "SIGTERM" });
      }
      await expect(fs.access(runtimeConfigHome)).rejects.toThrow();
      await expect(fetch(relayUrl)).rejects.toThrow();
    },
  );
});
