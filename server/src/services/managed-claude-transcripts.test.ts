import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  managedClaudeTranscriptExpirationService,
  retainManagedClaudeTranscripts,
} from "./managed-claude-transcripts.js";

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

type Runtime = { home: string; sessionIdentity: string; config?: Record<string, unknown> };

async function makeRuntime(overrides: Partial<Omit<Runtime, "home">> = {}): Promise<Runtime> {
  const home = await fs.mkdtemp(path.join(guestDir, "run-home-"));
  await fs.mkdir(path.join(home, "provider"), { mode: 0o700 });
  return { home, sessionIdentity: "grant-1:user-1:secret-1:0", ...overrides };
}

function retain(
  runtime: { home?: string; sessionIdentity: string; config?: Record<string, unknown> } | undefined,
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
  it("opts in per agent when the instance default is off and records its retention policy", async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED", "false");
    const enabled = await makeRuntime({ config: { transcriptRetentionEnabled: true, transcriptRetentionDays: 14 } });
    const disabled = await makeRuntime({ sessionIdentity: "another-account" });
    const [kept, skipped] = await Promise.all([retain(enabled), retain(disabled)]);
    expect(kept?.transcriptDir).toBeTruthy();
    expect(skipped).toBeUndefined();
    const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(kept!.transcriptDir), "task.json"), "utf8"));
    expect(metadata.retentionDays).toBe(14);
    await expect(fs.lstat(path.join(disabled.home, "provider", "projects"))).rejects.toThrow();
  });

  it("allows typed off to override an enabled instance and legacy agent value", async () => {
    const runtime = await makeRuntime({ config: { transcriptRetentionEnabled: false, env: { PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED: "true" } } });
    expect(await retain(runtime)).toBeUndefined();
  });

  it("never installs a transcript link for an explicitly configured Claude directory", async () => {
    const runtime = await makeRuntime({ config: { transcriptRetentionEnabled: true, managedAiHomeOverrides: { claudeConfigDir: true } } });
    expect(await retain(runtime)).toBeUndefined();
    await expect(fs.lstat(path.join(runtime.home, "provider", "projects"))).rejects.toThrow();
  });
  it("keeps nothing unless retention is turned on", async () => {
    for (const value of [undefined, "false", "1"]) {
      vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED", value);
      const runtime = await makeRuntime();
      expect(await retain(runtime)).toBeUndefined();
      await expect(fs.lstat(path.join(runtime.home, "provider", "projects"))).rejects.toThrow();
    }
  });

  it("does not retain transcripts in an explicitly configured HOME", async () => {
    const runtime = await makeRuntime();
    expect(await retain({ ...runtime, home: undefined })).toBeUndefined();
    await expect(fs.lstat(path.join(runtime.home, "provider", "projects"))).rejects.toThrow();
  });

  it("keeps a transcript for the task's next run after the credential home is deleted", async () => {
    const firstRun = await makeRuntime();
    const retained = await retain(firstRun);
    expect(retained?.home).toBe(firstRun.home);
    expect(retained?.transcriptDir).toBeTruthy();
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
    await fs.symlink(realHome, linkedHome, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("PAPERCLIP_HOME", linkedHome);
    const runtime = await makeRuntime();

    const retained = await retain(runtime);

    const target = await fs.readlink(path.join(runtime.home, "provider", "projects"));
    expect(target.startsWith(await fs.realpath(realHome))).toBe(true);
    expect(retained?.transcriptDir).toBe(await fs.realpath(path.join(runtime.home, "provider", "projects")));
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

describe("managed Claude transcript expiration sweep", () => {
  it("schedules a recorded agent policy without applying the shorter instance window", async () => {
    const root = path.join(guestDir, "instance");
    const dir = path.join(root, "companies", "company-1", "agents", "agent-1", "claude-transcripts", "0000000000000000");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "task.json");
    await fs.writeFile(file, JSON.stringify({ taskKey: "task-1", retentionDays: 14 }));
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const usedAt = new Date(now.getTime() - 10 * day);
    await fs.utimes(file, usedAt, usedAt);
    const result = await managedClaudeTranscriptExpirationService({} as never, { instanceRoot: root, retentionDays: 7, now }).tick();
    expect(result).toMatchObject({ expired: 0, failed: 0, nextDueAt: usedAt.getTime() + 14 * day });
    await expect(fs.access(file)).resolves.toBeUndefined();
  });
  it("rechecks completed scopes after a rescan, including after a failed discovery", async () => {
    const root = path.join(guestDir, "instance");
    const transcriptsDir = path.join(root, "companies", "company-1", "agents", "agent-1", "claude-transcripts");
    await fs.mkdir(transcriptsDir, { recursive: true });
    for (let index = 1; index <= 201; index += 1) {
      const id = index.toString(16).padStart(16, "0");
      const dir = path.join(transcriptsDir, id);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "task.json"), JSON.stringify({ taskKey: `task-${id}` }));
    }
    const service = managedClaudeTranscriptExpirationService({} as never, {
      instanceRoot: root,
      maxEntries: 200,
      now: new Date(),
    });

    const first = await service.tick();
    expect(first).toMatchObject({ checked: 200, truncated: true });

    const newEarlierScope = path.join(transcriptsDir, "0000000000000000");
    await fs.mkdir(newEarlierScope);
    await fs.writeFile(path.join(newEarlierScope, "task.json"), JSON.stringify({ taskKey: "new-task" }));
    const brokenCompanyAgents = path.join(root, "companies", "company-2", "agents");
    await fs.mkdir(path.dirname(brokenCompanyAgents), { recursive: true });
    await fs.writeFile(brokenCompanyAgents, "not a directory");
    service.requestRescan();

    await expect(service.tick()).rejects.toThrow();
    await fs.rm(brokenCompanyAgents);
    await fs.mkdir(brokenCompanyAgents);

    const second = await service.tick();
    expect(second).toMatchObject({ checked: 200, truncated: true });

    const third = await service.tick();
    expect(third).toMatchObject({ checked: 2, truncated: false });
  });
});
