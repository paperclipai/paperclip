import { describe, expect, it } from "vitest";

import {
  acpxBootstrapBlockedError,
  acpxSidecarErrorCode,
  enqueueAcpxSidecarInput,
  recordAcpxBootstrapFailure,
} from "./acpx-sidecar-input.js";

describe("ACPX sidecar input sequencing", () => {
  it("drains initialize, session.open, and suspend in input order", async () => {
    const events: string[] = [];
    let pending = Promise.resolve();
    for (const command of ["initialize", "session.open", "session.suspend"]) {
      pending = enqueueAcpxSidecarInput(
        pending,
        async () => {
          events.push(command);
        },
        () => events.push(`${command}:error`),
      );
    }
    const shutdown = pending.then(() => events.push("shutdown"));

    await shutdown;
    expect(events).toEqual([
      "initialize",
      "session.open",
      "session.suspend",
      "shutdown",
    ]);
  });

  it("keeps the queue live after operation and diagnostic failures", async () => {
    const events: string[] = [];
    const failed = enqueueAcpxSidecarInput(
      Promise.resolve(),
      async () => {
        events.push("failed");
        throw new Error("bad frame");
      },
      async () => {
        events.push("diagnostic");
        await Promise.resolve();
        throw new Error("diagnostic transport failed");
      },
    );
    const recovered = enqueueAcpxSidecarInput(
      failed,
      async () => {
        events.push("recovered");
      },
      () => events.push("unexpected"),
    );

    await recovered;
    expect(events).toEqual(["failed", "diagnostic", "recovered"]);
  });

  it("does not let an unbounded diagnostic block later input or shutdown", async () => {
    const events: string[] = [];
    const neverSettles = new Promise<void>(() => undefined);
    const failed = enqueueAcpxSidecarInput(
      Promise.resolve(),
      async () => {
        events.push("failed");
        throw new Error("bad frame");
      },
      () => {
        events.push("diagnostic");
        return neverSettles;
      },
    );
    const recovered = enqueueAcpxSidecarInput(
      failed,
      async () => {
        events.push("recovered");
      },
      () => events.push("unexpected"),
    );

    await expect(
      Promise.race([
        recovered.then(() => "drained"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("blocked"), 50);
        }),
      ]),
    ).resolves.toBe("drained");
    expect(events).toEqual(["failed", "diagnostic", "recovered"]);
  });

  it("preserves the first bootstrap failure and blocks dependent commands", () => {
    const rootCause = new Error("agent initialize exited");
    const failure = recordAcpxBootstrapFailure(null, "session.open", rootCause);

    expect(failure).toBe(rootCause);
    expect(acpxBootstrapBlockedError(failure, "session.suspend")?.message).toBe(
      "ACPX provider bootstrap failed before session.suspend: agent initialize exited",
    );
    expect(
      recordAcpxBootstrapFailure(
        failure,
        "session.suspend",
        new Error("secondary"),
      ),
    ).toBe(rootCause);
  });

  it("does not make an ordinary command failure a sticky bootstrap error", () => {
    expect(
      recordAcpxBootstrapFailure(null, "turn.start", new Error("turn failed")),
    ).toBeNull();
    expect(acpxBootstrapBlockedError(null, "turn.start")).toBeNull();
  });

  it("preserves stable ACPX error identities without copying startup stderr", () => {
    const missingModule = Object.assign(new Error("provider exited"), {
      detailCode: "AGENT_STARTUP_FAILED",
      stderrSummary:
        "Error [ERR_MODULE_NOT_FOUND]: violet-circuit-4821 was not found",
      exitCode: 1,
    });
    const opaqueExit = Object.assign(new Error("provider exited"), {
      detailCode: "AGENT_STARTUP_FAILED",
      stderrSummary: "violet-circuit-4821",
      exitCode: 1,
    });
    const model = Object.assign(new Error("model rejected"), {
      code: "ACP_MODEL_UNSUPPORTED",
      detailCode: "AGENT_STARTUP_FAILED",
    });
    const genericStartup = Object.assign(new Error("provider exited"), {
      outputCode: "RUNTIME",
      detailCode: "AGENT_STARTUP_FAILED",
      stderrSummary: "Error [ERR_MODULE_NOT_FOUND]: package was not found",
      exitCode: 1,
    });
    const genericRuntime = Object.assign(new Error("provider rejected"), {
      outputCode: "RUNTIME",
    });
    const nestedHandshake = new AggregateError(
      [
        Object.assign(new Error("admission deadline"), {
          name: "AcpxSessionHandshakeTimeoutError",
        }),
      ],
      "runtime initialization cleanup failed",
    );
    const codedWrapper = Object.assign(new Error("opaque wrapper"), {
      code: "ERR_UNCLASSIFIED_WRAPPER",
      cause: missingModule,
    });

    expect(acpxSidecarErrorCode(missingModule)).toBe(
      "AGENT_STARTUP_FAILED.MODULE_NOT_FOUND",
    );
    expect(acpxSidecarErrorCode(opaqueExit)).toBe(
      "AGENT_STARTUP_FAILED.EXIT_NONZERO",
    );
    expect(acpxSidecarErrorCode(opaqueExit)).not.toContain(
      "violet-circuit-4821",
    );
    expect(acpxSidecarErrorCode(model)).toBe("ACP_MODEL_UNSUPPORTED");
    expect(acpxSidecarErrorCode(genericStartup)).toBe(
      "AGENT_STARTUP_FAILED.MODULE_NOT_FOUND",
    );
    expect(acpxSidecarErrorCode(genericRuntime)).toBe("RUNTIME");
    expect(acpxSidecarErrorCode(codedWrapper)).toBe(
      "AGENT_STARTUP_FAILED.MODULE_NOT_FOUND",
    );
    expect(acpxSidecarErrorCode(nestedHandshake)).toBe(
      "ACPX_SESSION_HANDSHAKE_TIMEOUT",
    );
  });
});
