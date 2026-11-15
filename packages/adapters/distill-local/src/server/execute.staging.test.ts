import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const END_EVENT = '{"type":"end","stopReason":"end_turn","sessionId":"s1","usage":{"input_tokens":1,"output_tokens":1}}';

let root: string;
let cwd: string;
let command: string;

async function writeSkill(name: string, files: Record<string, string> = { "SKILL.md": "# skill\n" }) {
  const dir = path.join(root, "skills-src", name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(dir, file), content);
  return dir;
}

async function writeFakeDistill(body: string) {
  command = path.join(root, "fake-distill.sh");
  await fs.writeFile(command, `#!/bin/sh\n${body}\necho '${END_EVENT}'\n`, { mode: 0o755 });
}

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Test" },
    runtime: { sessionId: null, sessionParams: null },
    config: { cwd, command, promptTemplate: "go", ...config },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "distill-stage-"));
  cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  await writeFakeDistill("true");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("execute workspace staging", () => {
  it("removes the staged instructions and skills after the run", async () => {
    const instructions = path.join(root, "AGENTS-managed.md");
    await fs.writeFile(instructions, "be nice\n");
    const source = await writeSkill("alpha");
    const result = await execute(
      makeCtx({
        instructionsFilePath: instructions,
        paperclipRuntimeSkills: [{ key: "alpha", runtimeName: "alpha", source }],
        paperclipSkillSync: { desiredSkills: ["alpha"] },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(await fs.readdir(cwd)).toEqual([]);
  });

  it("keeps files the agent creates under .claude while removing only what Paperclip staged", async () => {
    const source = await writeSkill("alpha");
    await writeFakeDistill('echo "keep" > "$PWD/.claude/settings.json"');
    const result = await execute(
      makeCtx({
        paperclipRuntimeSkills: [{ key: "alpha", runtimeName: "alpha", source }],
        paperclipSkillSync: { desiredSkills: ["alpha"] },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(cwd, ".claude", "settings.json"), "utf8")).toBe("keep\n");
    await expect(fs.access(path.join(cwd, ".claude", "skills", "alpha"))).rejects.toThrow();
    await expect(fs.access(path.join(cwd, ".claude", "skills"))).rejects.toThrow();
  });

  it("rolls back Agents.md and earlier skills when a later skill copy fails", async () => {
    const instructions = path.join(root, "AGENTS-managed.md");
    await fs.writeFile(instructions, "be nice\n");
    const good = await writeSkill("alpha");
    const missing = path.join(root, "skills-src", "does-not-exist");
    await expect(
      execute(
        makeCtx({
          instructionsFilePath: instructions,
          paperclipRuntimeSkills: [
            { key: "alpha", runtimeName: "alpha", source: good },
            { key: "beta", runtimeName: "beta", source: missing },
          ],
          paperclipSkillSync: { desiredSkills: ["alpha", "beta"] },
        }),
      ),
    ).rejects.toThrow();
    expect(await fs.readdir(cwd)).toEqual([]);
  });
});
