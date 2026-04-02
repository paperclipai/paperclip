import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "@penclipai/adapter-codebuddy-local/server";

async function writeFakeCodeBuddyCommand(root: string, scriptBody: string): Promise<string> {
  if (process.platform === "win32") {
    const scriptPath = path.join(root, "codebuddy.js");
    const commandPath = path.join(root, "codebuddy.cmd");
    await fs.writeFile(scriptPath, scriptBody, "utf8");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  const commandPath = path.join(root, "codebuddy");
  await fs.writeFile(commandPath, `#!/usr/bin/env node\n${scriptBody}`, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  paperclipEnvKeys: string[];
  agentHome: string | null;
};

describe("codebuddy execute", () => {
  const cleanupDirs = new Set<string>();
  const previousEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  function swapEnv(key: string, value: string) {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  it("injects Paperclip env vars, instructions, and runtime skills before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-execute-"));
    cleanupDirs.add(root);
    const workspace = path.join(root, "workspace");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const agentHome = path.join(root, "agent-home");

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(instructionsPath, "# CEO\nRead HEARTBEAT.md from this directory.", "utf8");

    const paperclipDir = await createSkillDir(runtimeSkillsRoot, "paperclip");
    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");

    const commandPath = await writeFakeCodeBuddyCommand(
      root,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: codebuddy [options]\\n  --model <model>  Select model. Currently supported: (glm-5.0, glm-4.7, kimi-k2.5)");
  process.exit(0);
}
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: args,
  prompt: fs.readFileSync(0, "utf8"),
  paperclipEnvKeys: Object.keys(process.env).filter((key) => key.startsWith("PAPERCLIP_")).sort(),
  agentHome: process.env.AGENT_HOME ?? null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "codebuddy-session-1",
  model: "glm-5.0",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "codebuddy-session-1",
  usage: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 2 },
  total_cost_usd: 0.001,
  result: "done",
}));
`,
    );

    swapEnv("HOME", root);

    let invocationPrompt = "";
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodeBuddy Agent",
        adapterType: "codebuddy_local",
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
        model: "glm-5.0",
        effort: "high",
        maxTurnsPerRun: 7,
        instructionsFilePath: instructionsPath,
        promptTemplate: "Continue issue {{context.taskId}} for {{agent.name}}.",
        bootstrapPromptTemplate: "Bootstrap {{agent.id}}.",
        env: {
          HOME: root,
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
        },
        paperclipRuntimeSkills: [
          {
            key: "paperclip",
            runtimeName: "paperclip",
            source: paperclipDir,
            required: true,
            requiredReason: "Bundled Paperclip skills are always available for local adapters.",
          },
          {
            key: "ascii-heart",
            runtimeName: "ascii-heart",
            source: asciiHeartDir,
          },
        ],
        paperclipSkillSync: {
          desiredSkills: ["ascii-heart"],
        },
      },
      context: {
        taskId: "issue-123",
        paperclipSessionHandoffMarkdown: "Resume the active Paperclip task.",
        paperclipLocalizationPromptMarkdown: "Reply in the user's language.",
        paperclipWorkspace: {
          cwd: workspace,
          source: "workspace",
          workspaceId: "workspace-1",
          agentHome,
        },
      },
      authToken: "run-jwt-token",
      onLog: async () => {},
      onMeta: async (meta) => {
        invocationPrompt = meta.prompt ?? "";
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("codebuddy-session-1");
    expect(result.summary).toBe("hello");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 2,
    });

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
    expect(capture.argv).toEqual(
      expect.arrayContaining(["-p", "--output-format", "stream-json", "--model", "glm-5.0", "--effort", "high", "--max-turns", "7", "-y"]),
    );
    expect(capture.paperclipEnvKeys).toEqual(
      expect.arrayContaining([
        "PAPERCLIP_AGENT_ID",
        "PAPERCLIP_API_KEY",
        "PAPERCLIP_API_URL",
        "PAPERCLIP_COMPANY_ID",
        "PAPERCLIP_RUN_ID",
        "PAPERCLIP_TASK_ID",
      ]),
    );
    expect(capture.agentHome).toBe(agentHome);
    expect(capture.prompt).toContain("The above agent instructions were loaded from");
    expect(capture.prompt).toContain(`Resolve any relative file references from ${path.dirname(instructionsPath)}/`);
    expect(capture.prompt).toContain("Bootstrap agent-1.");
    expect(capture.prompt).toContain("Resume the active Paperclip task.");
    expect(capture.prompt).toContain("Paperclip runtime note:");
    expect(capture.prompt).toContain("Reply in the user's language.");
    expect(capture.prompt).toContain("Continue issue issue-123 for CodeBuddy Agent.");
    expect(invocationPrompt).toContain("Bootstrap agent-1.");
    expect(invocationPrompt).toContain("Reply in the user's language.");
    expect(await fs.realpath(path.join(root, ".codebuddy", "skills", "ascii-heart"))).toBe(
      await fs.realpath(asciiHeartDir),
    );
  });

  it("retries without --resume when CodeBuddy reports a missing session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-execute-resume-"));
    cleanupDirs.add(root);
    const workspace = path.join(root, "workspace");
    const attemptsPath = path.join(root, "attempts.jsonl");
    await fs.mkdir(workspace, { recursive: true });

    const commandPath = await writeFakeCodeBuddyCommand(
      root,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: codebuddy [options]\\n  --model <model>  Select model. Currently supported: (glm-5.0, glm-4.7)");
  process.exit(0);
}
const attemptsPath = process.env.PAPERCLIP_TEST_ATTEMPTS_PATH;
if (attemptsPath) {
  fs.appendFileSync(attemptsPath, JSON.stringify(args) + "\\n", "utf8");
}
if (args.includes("--resume")) {
  console.log(JSON.stringify({
    type: "error",
    message: "No conversation found with session ID: stale-session",
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "fresh-session",
  model: "glm-5.0",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "recovered" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "fresh-session",
  result: "ok",
}));
`,
    );

    swapEnv("HOME", root);

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-2",
        companyId: "company-1",
        name: "CodeBuddy Agent",
        adapterType: "codebuddy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-session",
        sessionParams: {
          sessionId: "stale-session",
          cwd: workspace,
        },
        sessionDisplayId: "stale-session",
        taskKey: null,
      },
      config: {
        command: commandPath,
        cwd: workspace,
        model: "glm-5.0",
        env: {
          HOME: root,
          PAPERCLIP_TEST_ATTEMPTS_PATH: attemptsPath,
        },
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.clearSession).toBe(true);
    expect(result.sessionId).toBe("fresh-session");

    const attempts = (await fs.readFile(attemptsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(expect.arrayContaining(["--resume", "stale-session"]));
    expect(attempts[1]).not.toContain("--resume");
  });
});
