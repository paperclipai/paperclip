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

  it("consumes a heartbeat-corrected config.instructionsFilePath end-to-end (AGE-168/AGE-484)", async () => {
    // This proves resolveHeartbeatManagedInstructionsPatch's corrected instructionsFilePath
    // actually reaches the injected system prompt in a real pi-local execute() run, not just
    // that the resolver function returns the right value in isolation.
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
    process.env.PAPERCLIP_HOME = paperclipHome;

    try {
      const agent = {
        id: "agent-instructions-patch",
        companyId: "company-instructions-patch",
        name: "Pi Agent",
        adapterConfig: {} as Record<string, unknown>,
      };

      // Step 1: agent is configured in managed mode under instance root A.
      process.env.PAPERCLIP_INSTANCE_ID = "instance-a";
      const managedRootA = path.join(
        paperclipHome,
        "instances",
        "instance-a",
        "companies",
        agent.companyId,
        "agents",
        agent.id,
        "instructions",
      );
      await fs.mkdir(managedRootA, { recursive: true });
      await fs.writeFile(path.join(managedRootA, "AGENTS.md"), "OLD STALE INSTRUCTIONS FROM ROOT A", "utf8");
      agent.adapterConfig = {
        instructionsBundleMode: "managed",
        instructionsRootPath: managedRootA,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: path.join(managedRootA, "AGENTS.md"),
      };

      // Step 2: instance root is re-pointed to B; the real instructions file lives under the
      // *current* managed root, not the stale root A recorded in adapterConfig.
      process.env.PAPERCLIP_INSTANCE_ID = "instance-b";
      const managedRootB = path.join(
        paperclipHome,
        "instances",
        "instance-b",
        "companies",
        agent.companyId,
        "agents",
        agent.id,
        "instructions",
      );
      await fs.mkdir(managedRootB, { recursive: true });
      await fs.writeFile(path.join(managedRootB, "AGENTS.md"), "NEW MANAGED INSTRUCTIONS FROM ROOT B", "utf8");

      const patch = await resolveHeartbeatManagedInstructionsPatch(agent);
      expect(patch).toMatchObject({
        instructionsRootPath: managedRootB,
        instructionsFilePath: path.join(managedRootB, "AGENTS.md"),
      });
      if (!("instructionsFilePath" in patch)) throw new Error("expected a correction patch");

      const result = await execute({
        runId: "run-pi-instructions-patch",
        agent: {
          id: agent.id,
          companyId: agent.companyId,
          name: agent.name,
          adapterType: "pi_local",
          adapterConfig: agent.adapterConfig,
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
          // Mirrors what heartbeat.ts applies to `config` before it reaches the adapter.
          instructionsFilePath: patch.instructionsFilePath,
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capturedSystemPrompt = await fs.readFile(systemPromptDumpPath, "utf8");
      expect(capturedSystemPrompt).toContain("NEW MANAGED INSTRUCTIONS FROM ROOT B");
      expect(capturedSystemPrompt).not.toContain("OLD STALE INSTRUCTIONS FROM ROOT A");
      expect(capturedSystemPrompt).toContain(`loaded from ${path.join(managedRootB, "AGENTS.md")}`);
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
