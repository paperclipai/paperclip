import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { retainManagedClaudeTranscripts } from "./managed-claude-transcripts.js";

let guestDir: string;

beforeEach(async () => {
  guestDir = await fs.mkdtemp(path.join(os.tmpdir(), "pap-ai-runtime-guest-"));
  vi.stubEnv("PAPERCLIP_HOME", await fs.mkdtemp(path.join(guestDir, "home-")));
  vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED", "true");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(guestDir, { recursive: true, force: true });
});

type Runtime = { home: string; sessionIdentity: string };

async function makeRuntime(overrides: Partial<Omit<Runtime, "home">> = {}): Promise<Runtime> {
  const home = await fs.mkdtemp(path.join(guestDir, "run-home-"));
  await fs.mkdir(path.join(home, "provider"), { mode: 0o700 });
  return { home, sessionIdentity: "grant-1:user-1:secret-1:0", ...overrides };
}

function retain(
  runtime: Runtime | undefined,
  options: { adapterType?: string; taskKey?: string | null; target?: unknown } = {},
) {
  return retainManagedClaudeTranscripts({
    runtime,
    adapterType: options.adapterType ?? "claude_local",
    companyId: "company-1",
    agentId: "agent-1",
    taskKey: options.taskKey === undefined ? "task-1" : options.taskKey,
    target: (options.target ?? { kind: "local" }) as never,
  });
}

const transcript = path.join("provider", "projects", "-workspace", "session-1.jsonl");

async function writeTranscript(home: string) {
  await fs.mkdir(path.dirname(path.join(home, transcript)), { recursive: true });
  await fs.writeFile(path.join(home, transcript), "turn-1");
}

describe("retainManagedClaudeTranscripts", () => {
  it("keeps nothing unless retention is turned on", async () => {
    for (const value of [undefined, "false", "1"]) {
      vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED", value);
      const runtime = await makeRuntime();
      expect(await retain(runtime)).toBeUndefined();
      await expect(fs.lstat(path.join(runtime.home, "provider", "projects"))).rejects.toThrow();
    }
  });

  it("keeps a transcript for the task's next run after the credential home is deleted", async () => {
    const firstRun = await makeRuntime();
    expect(await retain(firstRun)).toBe(firstRun.home);
    await writeTranscript(firstRun.home);
    await fs.writeFile(path.join(firstRun.home, "provider", ".credentials.json"), "secret");
    await fs.rm(firstRun.home, { recursive: true, force: true });

    const secondRun = await makeRuntime();
    await retain(secondRun);

    await expect(fs.readFile(path.join(secondRun.home, transcript), "utf8")).resolves.toBe("turn-1");
    await expect(fs.access(firstRun.home)).rejects.toThrow();
  });

  it("does not show transcripts to another task or account", async () => {
    const owner = await makeRuntime();
    await retain(owner);
    await writeTranscript(owner.home);

    const otherTask = await makeRuntime();
    await retain(otherTask, { taskKey: "task-2" });
    const otherAccount = await makeRuntime({ sessionIdentity: "grant-1:user-2:secret-1:0" });
    await retain(otherAccount);

    await expect(fs.access(path.join(otherTask.home, transcript))).rejects.toThrow();
    await expect(fs.access(path.join(otherAccount.home, transcript))).rejects.toThrow();
  });

  it("does not show transcripts to a credential rotated within the same grant", async () => {
    const owner = await makeRuntime();
    await retain(owner);
    await writeTranscript(owner.home);

    const rotatedCredential = await makeRuntime({ sessionIdentity: "grant-1:user-1:secret-1:1" });
    await retain(rotatedCredential);

    await expect(fs.access(path.join(rotatedCredential.home, transcript))).rejects.toThrow();
  });

  it("links the real path so filesystem confinement can mount it", async () => {
    const realHome = await fs.mkdtemp(path.join(guestDir, "real-"));
    const linkedHome = path.join(guestDir, "linked");
    await fs.symlink(realHome, linkedHome);
    vi.stubEnv("PAPERCLIP_HOME", linkedHome);
    const runtime = await makeRuntime();

    await retain(runtime);

    const target = await fs.readlink(path.join(runtime.home, "provider", "projects"));
    expect(target.startsWith(await fs.realpath(realHome))).toBe(true);
  });

  it("retains nothing for remote targets, other adapters, unscoped runs, or a failed link", async () => {
    const remote = await makeRuntime();
    const codex = await makeRuntime();
    const missingHome = await makeRuntime();
    await fs.rm(missingHome.home, { recursive: true });
    const linkTaken = await makeRuntime();
    await fs.mkdir(path.join(linkTaken.home, "provider", "projects"));

    expect(await retain(undefined)).toBeUndefined();
    expect(await retain(await makeRuntime(), { taskKey: null })).toBeUndefined();
    expect(await retain(remote, { target: { kind: "remote" } })).toBeUndefined();
    expect(await retain(codex, { adapterType: "codex_local" })).toBeUndefined();
    expect(await retain(missingHome)).toBeUndefined();
    expect(await retain(linkTaken)).toBeUndefined();

    await expect(fs.lstat(path.join(remote.home, "provider", "projects"))).rejects.toThrow();
    await expect(fs.lstat(path.join(codex.home, "provider", "projects"))).rejects.toThrow();
  });
});
