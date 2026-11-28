import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runChildProcess = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess };
});

import { execute } from "./execute.js";
import { buildRunTokenGuidance, startRunTokenFile } from "./run-token-file.js";

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

const waitFor = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
};

function makeCtx(authToken?: string) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5 },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    authToken,
  } as unknown as Parameters<typeof execute>[0];
}

const tokenPathFrom = (prompt: string) => {
  const match = prompt.match(/\$\(cat '(\/[^']+)'\)/);
  if (!match) throw new Error("token path not in prompt");
  return match[1];
};

describe("startRunTokenFile", () => {
  it("writes a private file per run", async () => {
    const first = await startRunTokenFile("token-a");
    const second = await startRunTokenFile("token-b");
    try {
      expect(first.path).not.toBe(second.path);
      expect(await fs.readFile(first.path, "utf8")).toBe("token-a");
      expect(await fs.readFile(second.path, "utf8")).toBe("token-b");
      expect((await fs.stat(first.path)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(first.path))).mode & 0o777).toBe(0o700);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it("restores the file and its directory while the run is active", async () => {
    const tokenFile = await startRunTokenFile("token-a", { restoreIntervalMs: 5 });
    try {
      await fs.rm(path.dirname(tokenFile.path), { recursive: true });
      await waitFor(() => exists(tokenFile.path));
      expect(await fs.readFile(tokenFile.path, "utf8")).toBe("token-a");
      expect((await fs.stat(tokenFile.path)).mode & 0o777).toBe(0o600);
    } finally {
      await tokenFile.stop();
    }
  });

  it("removes the file on stop and does not restore it", async () => {
    const tokenFile = await startRunTokenFile("token-a", { restoreIntervalMs: 5 });
    await tokenFile.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await exists(path.dirname(tokenFile.path))).toBe(false);
  });

  it("does not restore into a directory that is not private", async () => {
    const tokenFile = await startRunTokenFile("token-a", { restoreIntervalMs: 5 });
    try {
      await fs.rm(tokenFile.path);
      await fs.chmod(path.dirname(tokenFile.path), 0o755);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await exists(tokenFile.path)).toBe(false);
    } finally {
      await tokenFile.stop();
    }
  });

  it("does not write through a file that exists", async () => {
    const tokenFile = await startRunTokenFile("token-a", { restoreIntervalMs: 5 });
    try {
      await fs.writeFile(tokenFile.path, "other");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await fs.readFile(tokenFile.path, "utf8")).toBe("other");
    } finally {
      await tokenFile.stop();
    }
  });

  it("waits for an active restore before it removes the directory", async () => {
    const tokenFile = await startRunTokenFile("token-a", { restoreIntervalMs: 1 });
    const originalWrite = fs.writeFile;
    let started = false;
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalWrite(...args);
    });
    try {
      await fs.rm(tokenFile.path);
      await waitFor(async () => started);
      await tokenFile.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await exists(path.dirname(tokenFile.path))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("removes the directory when the first write fails", async () => {
    const spy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(startRunTokenFile("token-a")).rejects.toThrow("disk full");
      const file = String(spy.mock.calls[0][0]);
      expect(await exists(path.dirname(file))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("names the path and not the token in the guidance", () => {
    const guidance = buildRunTokenGuidance("/tmp/run/token");
    expect(guidance).toContain("$(cat '/tmp/run/token')");
    expect(guidance).toContain("/api/agents/me/secrets");
  });

  it("quotes paths with spaces and single quotes", () => {
    const guidance = buildRunTokenGuidance("/tmp/my run/it's/token");
    expect(guidance).toContain(`$(cat '/tmp/my run/it'\\''s/token')`);
  });
});

describe("hermes-local run token delivery", () => {
  afterEach(() => {
    runChildProcess.mockReset();
  });

  it("gives the run a token file for its lifetime", async () => {
    let tokenPath = "";
    let contents = "";
    runChildProcess.mockImplementation(async (_runId, _command, _args, opts) => {
      tokenPath = tokenPathFrom(opts.env.HERMES_EPHEMERAL_SYSTEM_PROMPT);
      contents = await fs.readFile(tokenPath, "utf8");
      expect(opts.env.PAPERCLIP_API_KEY).toBe("run-jwt");
      expect(opts.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).not.toContain("run-jwt");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    });

    await execute(makeCtx("run-jwt"));

    expect(contents).toBe("run-jwt");
    expect(await exists(path.dirname(tokenPath))).toBe(false);
  });

  it("removes the token file when the run throws", async () => {
    let tokenPath = "";
    runChildProcess.mockImplementation(async (_runId, _command, _args, opts) => {
      tokenPath = tokenPathFrom(opts.env.HERMES_EPHEMERAL_SYSTEM_PROMPT);
      throw new Error("spawn failed");
    });

    await expect(execute(makeCtx("run-jwt"))).rejects.toThrow("spawn failed");

    expect(tokenPath).not.toBe("");
    expect(await exists(path.dirname(tokenPath))).toBe(false);
  });

  it("adds no guidance when the run has no token", async () => {
    let prompt = "";
    runChildProcess.mockImplementation(async (_runId, _command, _args, opts) => {
      prompt = opts.env.HERMES_EPHEMERAL_SYSTEM_PROMPT;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    });

    await execute(makeCtx());

    expect(prompt).not.toContain("Paperclip secrets guidance");
  });
});
