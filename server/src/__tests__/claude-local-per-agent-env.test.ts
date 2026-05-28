import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeEnvCaptureClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const probeKey = process.env.PAPERCLIP_TEST_PROBE_KEY;
const payload = {
  probeKey,
  probeValue: probeKey ? (process.env[probeKey] ?? null) : null,
  hasInstanceLeak: process.env.PER_AGENT_LEAK_PROBE ?? null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-x", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-x", message: { content: [{ type: "text", text: "ok" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-x", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

const COMPANY_ID = "company1";
const AGENT_WITH_ENV = "agentA";
const AGENT_WITHOUT_ENV = "agentB";

interface TestEnv {
  root: string;
  paperclipHome: string;
  workspace: string;
  commandPath: string;
  capturePath: string;
  agentEnvFilePath: string;
  restore: () => void;
}

async function setupPerAgentEnvFixture(): Promise<TestEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-per-agent-env-"));
  const paperclipHome = path.join(root, "home");
  const instanceRoot = path.join(paperclipHome, "instances", "default");
  const agentDirA = path.join(instanceRoot, "companies", COMPANY_ID, "agents", AGENT_WITH_ENV);
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const commandPath = path.join(binDir, "claude");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(agentDirA, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeEnvCaptureClaudeCommand(commandPath);

  const previous = {
    PAPERCLIP_HOME: process.env.PAPERCLIP_HOME,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PER_AGENT_LEAK_PROBE: process.env.PER_AGENT_LEAK_PROBE,
  };
  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env.HOME = root;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  delete process.env.PER_AGENT_LEAK_PROBE;

  return {
    root,
    paperclipHome,
    workspace,
    commandPath,
    capturePath,
    agentEnvFilePath: path.join(agentDirA, ".env"),
    restore: () => {
      for (const key of Object.keys(previous) as (keyof typeof previous)[]) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

describe("claude_local per-agent .env loading", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupPerAgentEnvFixture();
  });

  afterEach(async () => {
    env.restore();
    await fs.rm(env.root, { recursive: true, force: true });
  });

  it("injects per-agent .env values into the spawned run process", async () => {
    await fs.writeFile(
      env.agentEnvFilePath,
      "SUPABASE_SERVICE_ROLE_KEY=agent-secret-value\n",
      "utf8",
    );

    await execute({
      runId: "run-with-env",
      agent: {
        id: AGENT_WITH_ENV,
        companyId: COMPANY_ID,
        name: "Test",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: env.commandPath,
        cwd: env.workspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: env.capturePath,
          PAPERCLIP_TEST_PROBE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
        },
        promptTemplate: "Do work.",
      },
      context: {},
      authToken: "tok",
      onLog: async () => {},
    });

    const captured = JSON.parse(await fs.readFile(env.capturePath, "utf8"));
    expect(captured.probeValue).toBe("agent-secret-value");
  });

  it("does not leak per-agent .env values to other agents on the same instance", async () => {
    await fs.writeFile(
      env.agentEnvFilePath,
      "SUPABASE_SERVICE_ROLE_KEY=agent-secret-value\n",
      "utf8",
    );

    await execute({
      runId: "run-without-env",
      agent: {
        id: AGENT_WITHOUT_ENV,
        companyId: COMPANY_ID,
        name: "Other",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: env.commandPath,
        cwd: env.workspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: env.capturePath,
          PAPERCLIP_TEST_PROBE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
        },
        promptTemplate: "Do work.",
      },
      context: {},
      authToken: "tok",
      onLog: async () => {},
    });

    const captured = JSON.parse(await fs.readFile(env.capturePath, "utf8"));
    expect(captured.probeValue).toBeNull();
  });

  it("per-agent values override instance env vars (process.env) for the agent that owns them", async () => {
    await fs.writeFile(
      env.agentEnvFilePath,
      "PER_AGENT_LEAK_PROBE=agent-value\n",
      "utf8",
    );
    process.env.PER_AGENT_LEAK_PROBE = "instance-value";

    await execute({
      runId: "run-override",
      agent: {
        id: AGENT_WITH_ENV,
        companyId: COMPANY_ID,
        name: "Test",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: env.commandPath,
        cwd: env.workspace,
        env: { PAPERCLIP_TEST_CAPTURE_PATH: env.capturePath },
        promptTemplate: "Do work.",
      },
      context: {},
      authToken: "tok",
      onLog: async () => {},
    });

    const captured = JSON.parse(await fs.readFile(env.capturePath, "utf8"));
    expect(captured.hasInstanceLeak).toBe("agent-value");
  });

  it("adapterConfig.env still wins over per-agent .env on key collision", async () => {
    await fs.writeFile(
      env.agentEnvFilePath,
      "OVERRIDDEN_BY_CONFIG=from-agent-env\n",
      "utf8",
    );

    await execute({
      runId: "run-config-wins",
      agent: {
        id: AGENT_WITH_ENV,
        companyId: COMPANY_ID,
        name: "Test",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: env.commandPath,
        cwd: env.workspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: env.capturePath,
          PAPERCLIP_TEST_PROBE_KEY: "OVERRIDDEN_BY_CONFIG",
          OVERRIDDEN_BY_CONFIG: "from-config",
        },
        promptTemplate: "Do work.",
      },
      context: {},
      authToken: "tok",
      onLog: async () => {},
    });

    const captured = JSON.parse(await fs.readFile(env.capturePath, "utf8"));
    expect(captured.probeValue).toBe("from-config");
  });

  it("treats a missing per-agent .env file as no-op", async () => {
    await execute({
      runId: "run-no-file",
      agent: {
        id: AGENT_WITH_ENV,
        companyId: COMPANY_ID,
        name: "Test",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: env.commandPath,
        cwd: env.workspace,
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: env.capturePath,
          PAPERCLIP_TEST_PROBE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
        },
        promptTemplate: "Do work.",
      },
      context: {},
      authToken: "tok",
      onLog: async () => {},
    });

    const captured = JSON.parse(await fs.readFile(env.capturePath, "utf8"));
    expect(captured.probeValue).toBeNull();
  });
});
