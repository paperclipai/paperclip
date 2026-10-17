import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverPiModels, execute, testEnvironment } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({
  type: "auto_retry_end",
  success: false,
  attempt: 3,
  finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"
}));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeEnvDumpPiCommand(commandPath: string, envDumpPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(envDumpPath)}, process.env.PATH || "");
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local execute", () => {
  it("fails the run when Pi exhausts automatic retries despite exiting 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-pi-quota-exhausted",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("RESOURCE_EXHAUSTED");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepends installed skill bin/ dirs to the spawned Pi child PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const skillDir = path.join(root, "skills", "demo-skill");
    const skillBinDir = path.join(skillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillBinDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# demo-skill\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path",
        agent: {
          id: "agent-skill-path",
          companyId: "company-skill-path",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          paperclipRuntimeSkills: [
            { key: "demo-skill", runtimeName: "demo-skill", source: skillDir },
          ],
          paperclipSkillSync: {
            desiredSkills: ["demo-skill"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      const entries = capturedPath.split(path.delimiter);
      expect(entries[0]).toBe(skillBinDir);
      expect(entries.filter((entry) => entry === skillBinDir)).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose bin/ dirs from skills that are not injected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-neg-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const nonInjectedSkillDir = path.join(root, "skills", "not-injected");
    const nonInjectedBinDir = path.join(nonInjectedSkillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(nonInjectedBinDir, { recursive: true });
    await fs.writeFile(path.join(nonInjectedSkillDir, "SKILL.md"), "# not-injected\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path-neg",
        agent: {
          id: "agent-skill-path-neg",
          companyId: "company-skill-path-neg",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          // The implicit legacy default applies only to the canonical Paperclip
          // operational skill, so this unrelated skill remains unselected.
          paperclipRuntimeSkills: [
            { key: "not-injected", runtimeName: "not-injected", source: nonInjectedSkillDir },
          ],
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      expect(capturedPath.split(path.delimiter)).not.toContain(nonInjectedBinDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates server secrets during execution, model discovery, and environment probes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-env-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const envDumpPath = path.join(root, "captured-env.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
`, "utf8");
    await fs.chmod(commandPath, 0o755);

    const serverSecrets = {
      PAPERCLIP_AGENT_JWT_SECRET: "server-jwt-secret",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "server-tool-action-secret",
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/server/master.key",
    };
    const permittedEnv = {
      PAPERCLIP_RUNTIME_API_URL: "https://runtime.example.test",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
    };
    const inheritedEnv = { ...serverSecrets, ...permittedEnv };
    const previous = { HOME: process.env.HOME, ...Object.fromEntries(Object.keys(inheritedEnv).map((k) => [k, process.env[k]])) };
    process.env.HOME = root;
    Object.assign(process.env, inheritedEnv);

    try {
      // Discover directly so execute/testEnvironment cannot pre-sanitize this input.
      await discoverPiModels({ command: commandPath, cwd: workspace, env: { AGENT_SETTING: "kept" } });
      await execute({
        runId: "run-pi-env-leak",
        agent: { id: "agent-env", companyId: "company-env", name: "Pi Agent", adapterType: "pi_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          env: { AGENT_SETTING: "kept" },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const diagnostics = await testEnvironment({
        companyId: "company-env",
        adapterType: "pi_local",
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          env: { AGENT_SETTING: "kept" },
        },
      });
      expect(diagnostics.status).toBe("pass");

      const captures = (await fs.readFile(envDumpPath, "utf8")).trim().split("\n").map(
        (line) => JSON.parse(line) as { args: string[]; env: Record<string, string> },
      );
      const discovery = captures.find(({ args }) => args.includes("--list-models"));
      const execution = captures.find(({ env }) => env.PAPERCLIP_AGENT_ID === "agent-env");
      const probe = captures.find(({ args }) => args.includes("Respond with hello."));
      expect(discovery).toBeDefined();
      expect(execution).toBeDefined();
      expect(probe).toBeDefined();
      for (const capture of [discovery!, execution!, probe!]) {
        for (const key of Object.keys(serverSecrets)) expect(capture.env).not.toHaveProperty(key);
        expect(capture.env.AGENT_SETTING).toBe("kept");
        expect(capture.env).toMatchObject(permittedEnv);
      }
      expect(execution!.env.PAPERCLIP_API_KEY).toBe("run-jwt-token");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
