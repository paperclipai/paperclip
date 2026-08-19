import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";
import { resolveHeartbeatManagedInstructionsPatch } from "../services/agent-instructions.js";

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
          // No explicit paperclipSkillSync preference →
          // resolvePaperclipDesiredSkillNames returns [] → skill is not injected.
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

  it("consumes a heartbeat-corrected config.instructionsFilePath end-to-end (AGE-168)", async () => {
    // This proves resolveHeartbeatManagedInstructionsPatch's corrected instructionsFilePath actually
    // reaches the injected system prompt in a real pi-local execute() run -- not just that the
    // resolver function returns the right value in isolation (agent-instructions-service.test.ts
    // covers that in isolation already).
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-instructions-patch-"));
    const paperclipHome = path.join(root, "paperclip-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const systemPromptDumpPath = path.join(root, "captured-system-prompt.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(paperclipHome, { recursive: true });

    const captureSystemPromptScript = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
const flagIndex = process.argv.indexOf("--append-system-prompt");
const systemPrompt = flagIndex >= 0 ? process.argv[flagIndex + 1] : "";
fs.writeFileSync(${JSON.stringify(systemPromptDumpPath)}, systemPrompt);
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
    await fs.writeFile(commandPath, captureSystemPromptScript, "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.HOME = root;

    try {
      // Step 1: agent is configured in managed mode while the data dir is instance "a".
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "instance-a";
      const rootA = path.join(
        paperclipHome,
        "instances",
        "instance-a",
        "companies",
        "company-instructions-patch",
        "agents",
        "agent-instructions-patch",
        "instructions",
      );
      await fs.mkdir(rootA, { recursive: true });
      await fs.writeFile(path.join(rootA, "AGENTS.md"), "# Stale Instance A Instructions\n", "utf8");

      const agent = {
        id: "agent-instructions-patch",
        companyId: "company-instructions-patch",
        name: "Pi Agent",
        adapterConfig: {
          instructionsBundleMode: "managed" as const,
          instructionsRootPath: rootA,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: path.join(rootA, "AGENTS.md"),
        },
      };

      // Step 2: the data dir moves to instance "b" (no symlink shim) -- the agent's persisted
      // adapterConfig still points at stale root A, but the real instructions now live under B.
      process.env.PAPERCLIP_INSTANCE_ID = "instance-b";
      const rootB = path.join(
        paperclipHome,
        "instances",
        "instance-b",
        "companies",
        "company-instructions-patch",
        "agents",
        "agent-instructions-patch",
        "instructions",
      );
      await fs.mkdir(rootB, { recursive: true });
      await fs.writeFile(path.join(rootB, "AGENTS.md"), "# Recovered Instance B Instructions\n", "utf8");

      // This is the same correction heartbeat.ts applies to `config` before it flows into
      // buildExecutionWorkspaceAdapterConfig / the runtime config an adapter executes with.
      const patch = await resolveHeartbeatManagedInstructionsPatch(agent);
      expect(patch).toMatchObject({ instructionsFilePath: path.join(rootB, "AGENTS.md") });
      const correctedConfig = { ...agent.adapterConfig, ...patch };

      await execute({
        runId: "run-pi-instructions-patch",
        agent: {
          id: agent.id,
          companyId: agent.companyId,
          name: agent.name,
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
          ...correctedConfig,
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedSystemPrompt = await fs.readFile(systemPromptDumpPath, "utf8");
      expect(capturedSystemPrompt).toContain("# Recovered Instance B Instructions");
      expect(capturedSystemPrompt).not.toContain("Stale Instance A Instructions");
      expect(capturedSystemPrompt).toContain(path.join(rootB, "AGENTS.md"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
