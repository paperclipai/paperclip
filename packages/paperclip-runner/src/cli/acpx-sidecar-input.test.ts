import { describe, expect, it } from "vitest";
import { createGrokEffortAdmission } from "../drivers/acpx/grok-effort.js";
import { recordAcpxAdmissionFailure } from "../drivers/acpx/admission-diagnostics.js";

import {
  acpxBootstrapBlockedError,
  acpxSidecarErrorCode,
  enqueueAcpxSidecarInput,
  recordAcpxBootstrapFailure,
} from "./acpx-sidecar-input.js";

describe("ACPX sidecar input sequencing", () => {
  it("prefers a known cause to a stage and ignores provider-supplied stage fields", () => {
    const cause = Object.assign(new Error("private-token-canary"), { code: "AUTH_REQUIRED" });
    const error = new AggregateError([cause], "private-wrapper");
    recordAcpxAdmissionFailure(error, "runtime");
    expect(acpxSidecarErrorCode(error)).toBe("AUTH_REQUIRED");
    expect(acpxSidecarErrorCode(Object.assign(new Error("private-token-canary"), {
      acpxAdmissionStage: "credential", code: "ACPX_ADMISSION_CREDENTIAL",
    }))).toBe("acpx_sidecar_command_failed");
  });
  it("retains a closed fallback stage through aggregate cleanup without changing the original error", () => {
    const error = Object.freeze(new Error("private-token-canary"));
    expect(recordAcpxAdmissionFailure(error, "credential")).toBe(error);
    recordAcpxAdmissionFailure(error, "runtime");
    expect(acpxSidecarErrorCode(new AggregateError([error], "private-wrapper"))).toBe("ACPX_ADMISSION_CREDENTIAL");
    expect(acpxSidecarErrorCode(new Error("ACPX_ADMISSION_CREDENTIAL private-token-canary"))).toBe("acpx_sidecar_command_failed");
  });
  it("preserves a Grok admission rejection without exporting the native payload", () => {
    const admission = createGrokEffortAdmission("high", "grok-4.7");
    const guard = admission.createGuard();
    guard("outbound", { id: 1, method: "session/new", params: {} });
    let failure: Error | undefined;
    try {
      guard("inbound", { id: 1, result: { sessionId: "private-session", _meta: { privateToken: "private-token-canary" } } });
    } catch (error) { failure = error as Error; }
    expect(failure).toBeInstanceOf(Error);
    expect(acpxSidecarErrorCode(failure!)).toBe("GROK_EFFORT_ACKNOWLEDGEMENT_MISSING");
    expect(failure!.message).not.toContain("private-token-canary");
    expect(() => admission.assertReady()).toThrow(failure);
  });
  it("classifies a retired tool callback without copying provider text into its identity", () => {
    const error = Object.assign(new Error("private-token-canary"), { code: "ACPX_TOOL_CALL_STALE" });
    expect(acpxSidecarErrorCode(error)).toBe("ACPX_TOOL_CALL_STALE");
    error.code = "ACPX_TOOL_CALL_STALE_EXTRA";
    expect(acpxSidecarErrorCode(error)).toBe("acpx_sidecar_command_failed");
  });
  it("preserves the closed JSON-RPC session ensure categories", () => {
    for (const code of [
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_AUTH_REQUIRED",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INTERNAL_ERROR",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INVALID_PARAMS",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INVALID_REQUEST",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_METHOD_NOT_FOUND",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_OTHER",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_PARSE_ERROR",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_REQUEST_CANCELLED",
      "ACPX_SESSION_ENSURE_FAILED.JSONRPC_RESOURCE_NOT_FOUND",
    ]) {
      const error = Object.assign(new Error("private-token-canary"), { code });
      expect(acpxSidecarErrorCode(error)).toBe(code);
    }
    const unknown = Object.assign(new Error("private-token-canary"), {
      code: "ACPX_SESSION_ENSURE_FAILED.JSONRPC_PRIVATE",
    });
    expect(acpxSidecarErrorCode(unknown)).toBe("acpx_sidecar_command_failed");
  });
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

  it.each(["COPILOT_POLICY_VIOLATION", "COPILOT_DETACHED_WORK_UNSUPPORTED"])("preserves Copilot policy identity %s", code => {
    const error = Object.assign(new Error("safe fixed policy message"), { code });
    expect(acpxSidecarErrorCode(error)).toBe(code);
    expect(acpxSidecarErrorCode(new Error("wrapped", { cause: error }))).toBe(code);
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

it("preserves a missing runtime package category across wrapped bootstrap errors", () => {
  const error = Object.assign(new Error("private resolver stack"), { code: "ACPX_RUNTIME_PACKAGE_MISSING" });
  expect(acpxSidecarErrorCode(new Error("bootstrap failed", { cause: error }))).toBe("ACPX_RUNTIME_PACKAGE_MISSING");
  expect(acpxSidecarErrorCode(acpxBootstrapBlockedError(error, "session.read")!)).toBe("ACPX_RUNTIME_PACKAGE_MISSING");
});
