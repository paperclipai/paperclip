import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpxLocalExecutor } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function onlyChildDir(parent: string): Promise<string> {
  const entries = await fs.readdir(parent);
  expect(entries).toHaveLength(1);
  return path.join(parent, entries[0]!);
}

async function createSkill(root: string, name: string, body = `---\nrequired: false\n---\n# ${name}\n`) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
  return {
    key: `paperclipai/test/${name}`,
    runtimeName: name,
    source: skillDir,
    required: false,
  };
}

function buildRuntime() {
  return {
    ensureSession: async () => ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
    }),
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    close: async () => {},
  };
}

async function runExecutor(config: Record<string, unknown>) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const execute = createAcpxLocalExecutor({
    createRuntime: (options) => {
      runtimeOptions.push(options as unknown as Record<string, unknown>);
      return buildRuntime() as never;
    },
  });

  const result = await execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
    },
    runtime: {},
    config,
    context: {},
    onLog: async (stream: "stdout" | "stderr", text: string) => {
      logs.push({ stream, text });
    },
    onMeta: async (payload: unknown) => {
      meta.push(payload as Record<string, unknown>);
    },
  } as never);

  expect(result.exitCode).toBe(0);
  return { logs, meta, runtimeOptions, result };
}

describe("acpx_local runtime skill isolation", () => {
  it.skipIf(process.platform === "win32")("materializes ACPX Claude skills without symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const skill = await createSkill(skillRoot, "danger");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(skill.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(skill.source, "leak-dir"));

    const stateDir = path.join(root, "state");
    const { meta } = await runExecutor({
      agent: "claude",
      stateDir,
      paperclipRuntimeSkills: [skill],
      paperclipSkillSync: { desiredSkills: [skill.key] },
    });

    const mountedRoot = await onlyChildDir(path.join(stateDir, "runtime-skills", "claude"));
    const skillsHome = path.join(mountedRoot, ".claude", "skills");
    const materializedSkill = path.join(skillsHome, skill.runtimeName);
    expect(await fs.readFile(path.join(materializedSkill, "SKILL.md"), "utf8")).toContain("# danger");
    expect(await pathExists(path.join(materializedSkill, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(materializedSkill, "leak-dir"))).toBe(false);
    expect(String(meta[0]?.prompt ?? "")).toContain(`Skill root: ${skillsHome}`);
  });

  it.skipIf(process.platform === "win32")("revokes removed ACPX Codex skills and skips symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const keep = await createSkill(skillRoot, "keep");
    const remove = await createSkill(skillRoot, "remove");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(keep.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(keep.source, "leak-dir"));

    const baseConfig = {
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [keep, remove],
    };

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key, remove.key] },
    });
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName, "SKILL.md"))).toBe(true);

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key] },
    });

    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak-dir"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("removes legacy ACPX Codex skill symlinks when a skill is no longer desired", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const codexHome = path.join(root, "codex-home");
    const legacy = await createSkill(skillRoot, "legacy");
    const skillsHome = path.join(codexHome, "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(legacy.source, path.join(skillsHome, legacy.runtimeName));

    await runExecutor({
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [legacy],
      paperclipSkillSync: { desiredSkills: [] },
    });

    expect(await pathExists(path.join(skillsHome, legacy.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("replaces stale managed Codex auth files with source symlinks", async () => {
    const root = await makeTempRoot();
    const sourceCodexHome = path.join(root, "source-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    const sourceAuth = path.join(sourceCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");
    await fs.writeFile(sourceAuth, "{\"source\":true}", "utf8");
    await fs.writeFile(managedAuth, "{\"stale\":true}", "utf8");

    const previousCodexHome = process.env.CODEX_HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    try {
      process.env.CODEX_HOME = sourceCodexHome;
      process.env.PAPERCLIP_HOME = paperclipHome;
      await runExecutor({
        agent: "codex",
        stateDir: path.join(root, "state"),
        paperclipRuntimeSkills: [],
        paperclipSkillSync: { desiredSkills: [] },
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    }

    const authStat = await fs.lstat(managedAuth);
    expect(authStat.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(managedAuth), await fs.readlink(managedAuth))).toBe(sourceAuth);
  });

  it("keeps fresh credential wrapper scripts across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      agent: "custom-a",
      env: { PAPERCLIP_API_KEY: "old-key" },
    });
    await runExecutor({
      ...baseConfig,
      agent: "custom-b",
      env: { PAPERCLIP_API_KEY: "new-key" },
    });

    const wrappers = await fs.readdir(path.join(stateDir, "wrappers"));
    expect(wrappers.filter((name) => name.endsWith(".sh"))).toHaveLength(2);
    expect(wrappers.filter((name) => name.endsWith(".env"))).toHaveLength(2);
    expect(wrappers.some((name) => name.startsWith("custom-a-"))).toBe(true);
    expect(wrappers.some((name) => name.startsWith("custom-b-"))).toBe(true);
    const wrapperPath = path.join(stateDir, "wrappers", wrappers.find((name) => name.startsWith("custom-b-") && name.endsWith(".sh"))!);
    const envPath = path.join(stateDir, "wrappers", wrappers.find((name) => name.startsWith("custom-b-") && name.endsWith(".env"))!);
    const wrapper = await fs.readFile(wrapperPath, "utf8");
    const env = await fs.readFile(envPath, "utf8");
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(wrapperPath)).mode & 0o777).toBe(0o700);
    expect(wrapper).toContain("node ./fake-acp.js");
    expect(wrapper).not.toContain("PAPERCLIP_API_KEY");
    expect(wrapper).not.toContain("new-key");
    expect(wrapper).not.toContain("old-key");
    expect(env).toContain("PAPERCLIP_API_KEY='new-key'");
    expect(env).not.toContain("old-key");
  });

  it("cleans aged credential wrapper scripts across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const wrappersDir = path.join(stateDir, "wrappers");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      agent: "custom-a",
      env: { PAPERCLIP_API_KEY: "old-key" },
    });
    const oldDate = new Date(Date.now() - 16 * 60 * 1000);
    await Promise.all(
      (await fs.readdir(wrappersDir))
        .filter((name) => name.startsWith("custom-a-"))
        .map((name) => fs.utimes(path.join(wrappersDir, name), oldDate, oldDate)),
    );

    await runExecutor({
      ...baseConfig,
      agent: "custom-b",
      env: { PAPERCLIP_API_KEY: "new-key" },
    });

    const wrappers = await fs.readdir(wrappersDir);
    expect(wrappers.filter((name) => name.endsWith(".sh"))).toHaveLength(1);
    expect(wrappers.filter((name) => name.endsWith(".env"))).toHaveLength(1);
    expect(wrappers.some((name) => name.startsWith("custom-a-"))).toBe(false);
    expect(wrappers.some((name) => name.startsWith("custom-b-"))).toBe(true);
  });

  it("keeps distinct wrapper env files for concurrent runs with different credentials", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agent: "custom-a",
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      env: { PAPERCLIP_API_KEY: "first-key" },
    });
    await runExecutor({
      ...baseConfig,
      env: { PAPERCLIP_API_KEY: "second-key" },
    });

    const envFileNames = (await fs.readdir(path.join(stateDir, "wrappers"))).filter((name) => name.endsWith(".env"));
    expect(envFileNames).toHaveLength(2);
    const envFiles = await Promise.all(
      envFileNames.map(async (name) => fs.readFile(path.join(stateDir, "wrappers", name), "utf8")),
    );
    expect(envFiles.filter((contents) => contents.includes("PAPERCLIP_API_KEY='first-key'"))).toHaveLength(1);
    expect(envFiles.filter((contents) => contents.includes("PAPERCLIP_API_KEY='second-key'"))).toHaveLength(1);
  });

  it("passes Paperclip env through the ACP agent wrapper instead of process.env", async () => {
    let observedApiKeyDuringStream: string | undefined;
    const execute = createAcpxLocalExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            await Promise.resolve();
            observedApiKeyDuringStream = process.env.PAPERCLIP_API_KEY;
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    try {
      delete process.env.PAPERCLIP_API_KEY;
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
        },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js" },
        context: {},
        authToken: "runtime-key",
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode).toBe(0);
      expect(observedApiKeyDuringStream).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });
});
