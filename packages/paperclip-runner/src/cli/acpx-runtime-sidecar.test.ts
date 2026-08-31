import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/sidecar-protocol.js";
import {
  awaitSidecarCleanupWithin,
  closeActiveSidecarHostWithin,
  closeSidecarHostForCommand,
  combineSidecarAdmissionCleanups,
  combineSidecarHostCleanups,
  hasSidecarSessionOwnership,
  observeSidecarCleanupWithin,
  parseAcpxRunAttachment,
  readSidecarHostStatusWithin,
  recoverAndCombineSidecarHostCleanup,
  recoverSidecarHostCleanup,
  reportAuthoritativeSidecarHostCleanupFailure,
  requireSidecarCommandHost,
  verifyOpenedAcpxSidecarHost,
} from "./acpx-sidecar-lifecycle.js";

const children = new Set<SidecarProcess>();

afterEach(async () => {
  await Promise.all([...children].map((child) => child.close()));
  children.clear();
});

describe("qualified ACPX runtime sidecar", () => {
  it("keeps session admission closed while any cleanup owner remains", () => {
    const cleanup = Promise.resolve();

    expect(hasSidecarSessionOwnership(null, null, null)).toBe(false);
    expect(hasSidecarSessionOwnership({}, null, null)).toBe(true);
    expect(hasSidecarSessionOwnership(null, cleanup, null)).toBe(true);
    expect(hasSidecarSessionOwnership(null, null, cleanup)).toBe(true);
  });

  it("allows only an explicit cleanup retry to reach a retained host", () => {
    const host = { identity: () => ({ kind: "acpx" }) };
    const cleanup = new Promise<void>(() => undefined);

    expect(() => requireSidecarCommandHost(host, cleanup)).toThrow(
      "cleanup is in progress",
    );
    expect(
      requireSidecarCommandHost(host, cleanup, { allowCleanupRetry: true }),
    ).toBe(host);
    expect(() =>
      requireSidecarCommandHost(null, cleanup, { allowCleanupRetry: true }),
    ).toThrow("session is not open");
  });

  it("closes an opened host when post-open verification fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn().mockRejectedValue(new Error("status failed")),
      close,
    };

    await expect(verifyOpenedAcpxSidecarHost(host, () => ({}))).rejects.toThrow(
      "status failed",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({
      reason: "ACPX session open verification failed",
    });
  });

  it("bounds failed-admission cleanup when the host does not settle", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn().mockRejectedValue(new Error("status failed")),
      close,
    };

    await expect(
      verifyOpenedAcpxSidecarHost(host, () => ({}), 1, retainCleanup),
    ).rejects.toThrow("verification and provider cleanup failed");
    expect(close).toHaveBeenCalledOnce();
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);
    finishCleanup();
    await cleanup;
  });

  it("bounds shutdown waiting without releasing retained cleanup ownership", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    await expect(awaitSidecarCleanupWithin(cleanup, 1)).resolves.toBe(
      "deferred",
    );
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    finishCleanup();
    await cleanup;
    expect(settled).toBe(true);
    await expect(awaitSidecarCleanupWithin(cleanup, 1)).resolves.toBe(
      "settled",
    );
  });

  it("preserves retained cleanup failure for shutdown accounting", async () => {
    const failure = new Error("provider cleanup failed");
    await expect(
      observeSidecarCleanupWithin(Promise.reject(failure), 1),
    ).resolves.toEqual({ status: "failed", error: failure });
    await expect(
      observeSidecarCleanupWithin(new Promise<void>(() => undefined), 1),
    ).resolves.toEqual({ status: "deferred" });
  });

  it("preserves failed-admission rejection until every cleanup settles", async () => {
    let finishCleanup!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const retained = combineSidecarAdmissionCleanups([
      Promise.reject(new Error("provider survived termination")),
      pending,
    ]);
    let settled = false;
    void retained.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    finishCleanup();
    await expect(retained).rejects.toThrow(
      "did not release provider ownership",
    );
  });

  it("bounds active-host cleanup during sidecar shutdown", async () => {
    const cleanup = new Promise<void>(() => undefined);
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();

    await expect(
      closeActiveSidecarHostWithin({ close }, "SIGTERM", 1, retainCleanup),
    ).resolves.toBe("deferred");
    expect(close).toHaveBeenCalledWith({ reason: "SIGTERM" });
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);
  });

  it("bounds command cleanup without replacing its exact owner", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();

    await expect(
      closeSidecarHostForCommand({ close }, "session close", 1, retainCleanup),
    ).rejects.toThrow("cleanup exceeded its command timeout");
    expect(close).toHaveBeenCalledOnce();
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);

    finishCleanup();
    await cleanup;
  });

  it("preserves a settled command cleanup failure", async () => {
    const cleanup = Promise.reject(new Error("runtime close failed"));
    await expect(
      closeSidecarHostForCommand({ close: () => cleanup }, "session close", 10),
    ).rejects.toThrow("runtime close failed");
  });

  it("recovers a rejected active-host cleanup sequentially", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockResolvedValue(undefined);
    const host = { close };
    const initialCleanup = host.close();

    await expect(
      recoverSidecarHostCleanup(host, initialCleanup),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated active-host cleanup failures", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("close failed"));
    const host = { close };
    const initialCleanup = host.close();

    await expect(
      recoverSidecarHostCleanup(host, initialCleanup),
    ).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("retains a pending cleanup owner after a command retry succeeds", async () => {
    let finishPending!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishPending = resolve;
    });
    const successfulRetry = Promise.resolve();
    const owner = combineSidecarHostCleanups([pending, successfulRetry]);
    let settled = false;
    void owner.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishPending();
    await expect(owner).resolves.toBeUndefined();
  });

  it("accepts a coalesced rejection after sequential recovery succeeds", async () => {
    let rejectCoalesced!: (error: unknown) => void;
    const coalesced = new Promise<void>((_resolve, reject) => {
      rejectCoalesced = reject;
    });
    const close = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(coalesced)
      .mockReturnValueOnce(coalesced)
      .mockResolvedValue(undefined);
    const host = { close };
    const recoveredPrior = recoverSidecarHostCleanup(host, host.close());
    const owner = recoverAndCombineSidecarHostCleanup(
      host,
      host.close(),
      recoveredPrior,
    );
    let settled = false;
    void owner
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await Promise.resolve();
    expect(settled).toBe(false);
    rejectCoalesced(new Error("coalesced close failed before recovery"));
    await expect(owner).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("rejects when every active-host cleanup owner fails", async () => {
    const owner = combineSidecarHostCleanups([
      Promise.reject(new Error("recovery exhausted")),
      Promise.reject(new Error("retry failed")),
    ]);

    await expect(owner).rejects.toThrow("did not release provider ownership");
  });

  it("accepts a later recovery after an older owner exhausts", async () => {
    await expect(
      combineSidecarHostCleanups([
        Promise.reject(new Error("older recovery exhausted")),
        Promise.resolve(),
      ]),
    ).resolves.toBeUndefined();
  });

  it("does not escalate a superseded cleanup owner failure", async () => {
    let rejectOlder!: (error: unknown) => void;
    const older = new Promise<void>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const replacement = combineSidecarHostCleanups([
      older,
      Promise.resolve(),
    ]);
    const reportFailure = vi.fn();
    void older.catch((error: unknown) => {
      reportAuthoritativeSidecarHostCleanupFailure(
        false,
        replacement,
        older,
        error,
        reportFailure,
      );
    });

    rejectOlder(new Error("older recovery exhausted"));
    await expect(replacement).resolves.toBeUndefined();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("escalates only an authoritative cleanup owner's terminal failure", async () => {
    const owner = combineSidecarHostCleanups([
      Promise.reject(new Error("older recovery exhausted")),
      Promise.reject(new Error("replacement recovery exhausted")),
    ]);
    const reportFailure = vi.fn();

    await owner.catch((error: unknown) => {
      reportAuthoritativeSidecarHostCleanupFailure(
        false,
        owner,
        owner,
        error,
        reportFailure,
      );
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);

    reportAuthoritativeSidecarHostCleanupFailure(
      true,
      owner,
      owner,
      new Error("shutdown cleanup failed"),
      reportFailure,
    );
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("bounds status verification before cleaning up the opened host", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn(() => new Promise<never>(() => undefined)),
      close,
    };

    await expect(
      verifyOpenedAcpxSidecarHost(host, () => ({}), 1),
    ).rejects.toThrow("status read exceeded its timeout");
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds ordinary status reads so serialized shutdown can proceed", async () => {
    const host = {
      status: vi.fn(() => new Promise<never>(() => undefined)),
    };

    await expect(readSidecarHostStatusWithin(host, 1)).rejects.toThrow(
      "status read exceeded its timeout",
    );
  });

  it("validates a complete run attachment before it can be committed", () => {
    let attachedRunId: string | null = null;
    const attach = (params: Record<string, unknown>) => {
      const attachment = parseAcpxRunAttachment(params);
      attachedRunId = attachment.runId;
      return attachment;
    };

    expect(() => attach({ runId: "run-1", catalogRevision: 0 })).toThrow(
      "catalogRevision must be a positive integer",
    );
    expect(attachedRunId).toBeNull();
    expect(attach({ runId: "run-1", catalogRevision: 2 })).toEqual({
      runId: "run-1",
      catalogRevision: 2,
    });
    expect(attachedRunId).toBe("run-1");
  });

  it("recovers after malformed input and reports its qualified Codex profile", async () => {
    const sidecar = startSidecar();
    sidecar.write({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      id: 1,
      command: "initialize",
      params: {},
      unexpected: true,
    });
    await expect(
      sidecar.next((frame) => frame.eventType === "runtime.diagnostic"),
    ).resolves.toMatchObject({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      eventType: "runtime.diagnostic",
      payload: { code: "malformed_frame" },
    });

    sidecar.write(initializeRequest(2, "codex"));

    await expect(
      sidecar.next((frame) => frame.id === 2),
    ).resolves.toMatchObject({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      id: 2,
      ok: true,
      result: {
        profile: {
          agent: "codex",
          qualificationModel: "gpt-5.6-sol",
        },
        capabilities: {
          persistentSessions: true,
          exactModelVerification: true,
          structuredInput: "paperclip.question_set.v1",
        },
      },
    });
    expect(sidecar.stderr()).toContain("malformed_frame");

    sidecar.write(initializeRequest(3, "codex"));
    await expect(
      sidecar.next((frame) => frame.id === 3),
    ).resolves.toMatchObject({
      id: 3,
      ok: false,
      error: { message: "ACPX sidecar is already initialized" },
    });
  });

  it.each([["claude", "claude-sonnet-5"]])(
    "reports the qualified %s profile",
    async (agent, model) => {
      const sidecar = startSidecar();
      sidecar.write(initializeRequest(1, agent, model));

      await expect(
        sidecar.next((frame) => frame.id === 1),
      ).resolves.toMatchObject({
        id: 1,
        ok: true,
        result: { profile: { agent, qualificationModel: model } },
      });
    },
  );

  it("fails closed after an unsupported provider bootstrap", async () => {
    const sidecar = startSidecar();
    sidecar.write(
      initializeRequest(
        1,
        "pi",
        "openrouter/deepseek/deepseek-v4-flash-0731",
      ),
    );

    await expect(
      sidecar.next((frame) => frame.id === 1),
    ).resolves.toMatchObject({
      id: 1,
      ok: false,
      error: {
        code: "acpx_sidecar_command_failed",
        message: "ACPX agent must be claude or codex",
        retryable: false,
      },
    });

    sidecar.write(initializeRequest(2, "codex"));

    await expect(
      sidecar.next((frame) => frame.id === 2),
    ).resolves.toMatchObject({
      id: 2,
      ok: false,
      error: {
        message: expect.stringContaining(
          "ACPX provider bootstrap failed before initialize",
        ),
        retryable: false,
      },
    });
  });
});

function initializeRequest(
  id: number,
  agent: string,
  model = "gpt-5.6-sol",
): Record<string, unknown> {
  return {
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id,
    command: "initialize",
    params: { agent, model },
  };
}

function startSidecar(): SidecarProcess {
  const sidecar = new SidecarProcess();
  children.add(sidecar);
  return sidecar;
}

class SidecarProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #frames: Array<Record<string, unknown>> = [];
  readonly #signals: Array<() => void> = [];
  #stderr = "";
  #closed = false;

  constructor() {
    this.#child = spawn(
      fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)),
      [fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        this.#frames.push(JSON.parse(line) as Record<string, unknown>);
        for (const signal of this.#signals.splice(0)) signal();
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  write(value: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stderr(): string {
    return this.#stderr;
  }

  async next(
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index >= 0) return this.#frames.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for sidecar frame. stderr=${JSON.stringify(this.#stderr)}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.#signals.indexOf(signal);
          if (index >= 0) this.#signals.splice(index, 1);
          reject(new Error("Timed out waiting for sidecar output"));
        }, remaining);
        const signal = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#signals.push(signal);
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    const exit = new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
    await Promise.race([exit, timeout]);
  }
}
