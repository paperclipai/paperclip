import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runChildProcessMock } = vi.hoisted(() => ({
  runChildProcessMock: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/server-utils")
  >("@paperclipai/adapter-utils/server-utils");
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
  };
});

import {
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
  resolvePiModelsCacheTtlMs,
  resolvePiModelsTimeoutMs,
} from "./models.js";

function modelsOutput(rows: Array<[string, string]>): string {
  const header =
    "provider      model                         context  max-out  thinking  images";
  const lines = rows.map(
    ([provider, model]) => `${provider}      ${model}                1M       128K     yes       yes`,
  );
  return [header, ...lines].join("\n");
}

function successResult(stderr: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function timedOutResult() {
  return {
    exitCode: null,
    signal: null,
    timedOut: true,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function failedResult(detail: string) {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: detail,
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LISTING = modelsOutput([
  ["meta", "muse-spark-1.3"],
  ["openai-codex", "gpt-5.5"],
]);

describe("pi models discovery", () => {
  beforeEach(() => {
    runChildProcessMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    delete process.env.PAPERCLIP_PI_MODELS_TIMEOUT_MS;
    delete process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS;
    resetPiModelsCacheForTests();
  });

  it("shares a single spawn across concurrent same-key discoveries", async () => {
    const gate = deferred<ReturnType<typeof successResult>>();
    runChildProcessMock.mockImplementation(() => gate.promise);
    const calls = Array.from({ length: 8 }, () => discoverPiModelsCached());
    await sleep(10);
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    gate.resolve(successResult(LISTING));
    const results = await Promise.all(calls);
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    for (const models of results) {
      expect(models.map((m) => m.id).sort()).toEqual([
        "meta/muse-spark-1.3",
        "openai-codex/gpt-5.5",
      ]);
    }
  });

  it("treats discovery as cwd-independent (different cwd shares cache)", async () => {
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    await discoverPiModelsCached({ cwd: "/tmp" });
    await discoverPiModelsCached({ cwd: "/" });
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
  });

  it("populates the cache on cold start and serves within-TTL calls with 0 spawns", async () => {
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    const first = await discoverPiModelsCached();
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    const second = await discoverPiModelsCached();
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-discovers after TTL expiry", async () => {
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "80";
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    await discoverPiModelsCached();
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    await sleep(150);
    await discoverPiModelsCached();
    expect(runChildProcessMock).toHaveBeenCalledTimes(2);
  });

  it("rejects on timeout and never caches the failure", async () => {
    runChildProcessMock.mockResolvedValue(timedOutResult());
    await expect(discoverPiModelsCached()).rejects.toThrow(
      "`pi --list-models` timed out.",
    );
    await expect(discoverPiModelsCached()).rejects.toThrow(
      "`pi --list-models` timed out.",
    );
    expect(runChildProcessMock).toHaveBeenCalledTimes(2);
  });

  it("rejects on non-zero exit with stderr detail and retries next call", async () => {
    runChildProcessMock.mockResolvedValue(failedResult("auth expired"));
    await expect(discoverPiModelsCached()).rejects.toThrow(
      "`pi --list-models` failed: auth expired",
    );
    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    const models = await discoverPiModelsCached();
    expect(models).toHaveLength(2);
    expect(runChildProcessMock).toHaveBeenCalledTimes(2);
  });

  it("rejects when the pi command is missing and retries next call", async () => {
    runChildProcessMock.mockRejectedValue(
      new Error('Command not found in PATH: "__paperclip_missing_pi_command__"'),
    );
    await expect(
      discoverPiModelsCached({ command: "__paperclip_missing_pi_command__" }),
    ).rejects.toThrow();
    await expect(
      discoverPiModelsCached({ command: "__paperclip_missing_pi_command__" }),
    ).rejects.toThrow();
    expect(runChildProcessMock).toHaveBeenCalledTimes(2);
  });

  it("defaults the spawn timeout to 45s and clamps configured values", async () => {
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    expect(resolvePiModelsTimeoutMs()).toBe(45_000);
    await discoverPiModelsCached();
    expect(runChildProcessMock.mock.calls[0]?.[3]?.timeoutSec).toBe(45);

    resetPiModelsCacheForTests();
    process.env.PAPERCLIP_PI_MODELS_TIMEOUT_MS = "90000";
    expect(resolvePiModelsTimeoutMs()).toBe(90_000);
    await discoverPiModelsCached();
    expect(runChildProcessMock.mock.calls[1]?.[3]?.timeoutSec).toBe(90);

    process.env.PAPERCLIP_PI_MODELS_TIMEOUT_MS = "garbage";
    expect(resolvePiModelsTimeoutMs()).toBe(45_000);
    process.env.PAPERCLIP_PI_MODELS_TIMEOUT_MS = "-5";
    expect(resolvePiModelsTimeoutMs()).toBe(45_000);
    process.env.PAPERCLIP_PI_MODELS_TIMEOUT_MS = "1000";
    expect(resolvePiModelsTimeoutMs()).toBe(5_000);
    process.env.PAPERCLIP_PI_MODELS_TIMEOUT_MS = "99999999";
    expect(resolvePiModelsTimeoutMs()).toBe(300_000);
  });

  it("keeps the 60s cache TTL default and clamps invalid values", () => {
    expect(resolvePiModelsCacheTtlMs()).toBe(60_000);
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "not-a-number";
    expect(resolvePiModelsCacheTtlMs()).toBe(60_000);
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "-10";
    expect(resolvePiModelsCacheTtlMs()).toBe(60_000);
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "120000";
    expect(resolvePiModelsCacheTtlMs()).toBe(120_000);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
    expect(runChildProcessMock).not.toHaveBeenCalled();
  });

  it("rejects when discovery cannot run for a configured model", async () => {
    runChildProcessMock.mockRejectedValue(
      new Error('Command not found in PATH: "__paperclip_missing_pi_command__"'),
    );
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "meta/muse-spark-1.3",
        command: "__paperclip_missing_pi_command__",
      }),
    ).rejects.toThrow();
  });

  it("rejects with an empty-model error when pi returns no models", async () => {
    runChildProcessMock.mockResolvedValue(
      successResult(
        "provider      model                         context  max-out  thinking  images",
      ),
    );
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "meta/muse-spark-1.3" }),
    ).rejects.toThrow("Pi returned no models");
  });

  it("rejects with an unavailable-model error listing available models", async () => {
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "nope/missing-model" }),
    ).rejects.toThrow("Configured Pi model is unavailable: nope/missing-model");
  });

  it("resolves the exact configured model when available", async () => {
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    const models = await ensurePiModelConfiguredAndAvailable({
      model: "meta/muse-spark-1.3",
    });
    expect(models.map((m) => m.id)).toContain("meta/muse-spark-1.3");
  });

  it("never leaks stale results into strict callers sharing a flight", async () => {
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "80";
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    const fresh = await discoverPiModelsCached();
    await sleep(150);

    runChildProcessMock.mockRejectedValue(new Error("spawn blew up"));
    const strictFirst = discoverPiModelsCached();
    const optInJoiner = discoverPiModelsCached({ allowStaleOnFailure: true });
    await expect(strictFirst).rejects.toThrow("spawn blew up");
    await expect(optInJoiner).resolves.toEqual(fresh);
    expect(runChildProcessMock).toHaveBeenCalledTimes(2);

    // Reverse order: opt-in creator fails, strict joiner still throws.
    resetPiModelsCacheForTests();
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    const fresh2 = await discoverPiModelsCached();
    await sleep(150);
    runChildProcessMock.mockRejectedValue(new Error("spawn blew up"));
    const optInFirst = discoverPiModelsCached({ allowStaleOnFailure: true });
    const strictJoiner = discoverPiModelsCached();
    await expect(optInFirst).resolves.toEqual(fresh2);
    await expect(strictJoiner).rejects.toThrow("spawn blew up");
  });

  it("listPiModels stays best-effort but honors explicit stale fallback", async () => {
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "80";
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    const fresh = await listPiModels();
    expect(fresh).toHaveLength(2);
    await sleep(150);

    runChildProcessMock.mockRejectedValue(new Error("spawn blew up"));
    await expect(listPiModels()).resolves.toEqual([]);
    const stale = await listPiModels({ allowStaleOnFailure: true });
    expect(stale).toEqual(fresh);
    // Failures are never cached: a later success re-discovers and replaces.
    runChildProcessMock.mockResolvedValue(successResult(LISTING));
    await expect(listPiModels()).resolves.toEqual(fresh);
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    runChildProcessMock.mockRejectedValue(
      new Error('Command not found in PATH: "__paperclip_missing_pi_command__"'),
    );
    await expect(
      listPiModels({ command: "__paperclip_missing_pi_command__" }),
    ).resolves.toEqual([]);
  });
});
