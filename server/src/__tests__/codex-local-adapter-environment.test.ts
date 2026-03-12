import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, testEnvironment } from "@paperclipai/adapter-codex-local/server";

const itWindows = process.platform === "win32" ? it : it.skip;
const ORIGINAL_OPENAI = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (ORIGINAL_OPENAI === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI;
  }
});

describe("codex_local environment diagnostics", () => {
  it("isolates API-key runs into a dedicated Codex home", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const agentHome = path.join(root, "agent-home");
    const fakeCodex = path.join(binDir, "codex");
    const script = `#!/usr/bin/env node
if (process.argv[2] === "login") {
  console.log("Successfully logged in");
  process.exit(0);
}
const expectedKey = "sk-host-test";
const codexHome = process.env.CODEX_HOME || "";
const home = process.env.HOME || "";
const ok =
  process.env.OPENAI_API_KEY === expectedKey &&
  codexHome === home &&
  codexHome.endsWith("${path.sep}.codex-api-key");
if (!ok) {
  console.error("unexpected-env");
  console.error(JSON.stringify({
    openAiKey: process.env.OPENAI_API_KEY || null,
    codexHome,
    home,
  }));
  process.exit(1);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

    try {
      process.env.OPENAI_API_KEY = "sk-host-test";
      process.env.PAPERCLIP_AGENT_RUNTIME_DIR = root;

      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");
      await fs.chmod(fakeCodex, 0o755);

      let invocationMeta: Record<string, unknown> | null = null;
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Agent",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "codex",
          cwd,
          paperclipAuthMode: "instance_api_key",
          instructionsFilePath: path.join(agentHome, "role", "AGENTS.md"),
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
        context: {},
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationMeta = meta.env ?? null;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.billingType).toBe("api");
      expect(invocationMeta).toMatchObject({
        CODEX_HOME: expect.stringContaining(`${path.sep}.codex-api-key`),
        HOME: expect.stringContaining(`${path.sep}.codex-api-key`),
        OPENAI_API_KEY: "***REDACTED***",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      delete process.env.PAPERCLIP_AGENT_RUNTIME_DIR;
    }
  });

  it("omits cwd in session params for agent_home workspaces", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-agent-home-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const configuredCwd = path.join(root, "configured-cwd");
    const workspaceCwd = path.join(root, "workspace-cwd");
    const fakeCodex = path.join(binDir, "codex");
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(configuredCwd, { recursive: true });
      await fs.mkdir(workspaceCwd, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");
      await fs.chmod(fakeCodex, 0o755);

      const result = await execute({
        runId: "run-agent-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Agent",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "codex",
          cwd: configuredCwd,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
        context: {
          paperclipWorkspace: {
            source: "agent_home",
            cwd: workspaceCwd,
            workspaceId: "workspace-1",
          },
        },
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionParams).toEqual({
        sessionId: "test-thread",
        workspaceId: "workspace-1",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates API-key probes from shared Codex login state", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-probe-posix-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex");
    const script = `#!/usr/bin/env node
if (process.argv[2] === "login") {
  console.log("Successfully logged in");
  process.exit(0);
}
const codexHome = process.env.CODEX_HOME || "";
const home = process.env.HOME || "";
const key = process.env.OPENAI_API_KEY || "";
const isolated = codexHome === home && codexHome.includes("paperclip-codex-envtest-");
if (!isolated || key !== "test-key") {
  console.error("probe-not-isolated");
  process.exit(1);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");
      await fs.chmod(fakeCodex, 0o755);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports explicit subscription override separately from missing keys", async () => {
    process.env.OPENAI_API_KEY = "sk-host";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        paperclipAuthMode: "subscription",
        env: {
          OPENAI_API_KEY: "",
        },
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "codex_subscription_override_active" &&
          check.level === "info",
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.code === "codex_openai_api_key_missing")).toBe(false);
  });

  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-codex-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "codex_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  itWindows("runs the hello probe when Codex is available via a Windows .cmd wrapper", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex.cmd");
    const script = [
      "@echo off",
      "if \"%1\"==\"login\" (",
      "echo Successfully logged in",
      "exit /b 0",
      ")",
      "echo {\"type\":\"thread.started\",\"thread_id\":\"test-thread\"}",
      "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
      "echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      "exit /b 0",
      "",
    ].join("\r\n");

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
