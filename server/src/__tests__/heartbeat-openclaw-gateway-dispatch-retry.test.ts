import { describe, expect, it, vi } from "vitest";
import {
  executeOpenClawGatewayDispatchWithRetry,
  isOpenClawGatewayDispatchRetryableResult,
  parseOpenClawGatewayDispatchRetryDelaysMs,
} from "../services/heartbeat.ts";

describe("heartbeat OpenClaw gateway dispatch retry", () => {
  it("parses default and overridden retry delays", () => {
    expect(parseOpenClawGatewayDispatchRetryDelaysMs(undefined)).toEqual([5_000, 15_000, 45_000]);
    expect(parseOpenClawGatewayDispatchRetryDelaysMs("0,1,2")).toEqual([0, 1, 2]);
    expect(parseOpenClawGatewayDispatchRetryDelaysMs("bad")).toEqual([5_000, 15_000, 45_000]);
  });

  it("only retries OpenClaw gateway request failures", () => {
    expect(
      isOpenClawGatewayDispatchRetryableResult(
        { adapterType: "openclaw_gateway" },
        {
          exitCode: 1,
          timedOut: false,
          errorCode: "openclaw_gateway_request_failed",
          errorMessage: "gateway request failed",
        },
      ),
    ).toBe(true);
    expect(
      isOpenClawGatewayDispatchRetryableResult(
        { adapterType: "openclaw_gateway" },
        {
          exitCode: 1,
          timedOut: false,
          errorCode: "openclaw_gateway_wait_error",
          errorMessage: "run failed",
        },
      ),
    ).toBe(false);
    expect(
      isOpenClawGatewayDispatchRetryableResult(
        { adapterType: "codex_local" },
        {
          exitCode: 1,
          timedOut: false,
          errorCode: "openclaw_gateway_request_failed",
          errorMessage: "gateway request failed",
        },
      ),
    ).toBe(false);
  });

  it("retries transient OpenClaw gateway dispatch failure and returns the recovered result", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        timedOut: false,
        errorCode: "openclaw_gateway_request_failed",
        errorMessage: "gateway request failed",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        timedOut: false,
        errorCode: "openclaw_gateway_request_failed",
        errorMessage: "gateway request failed",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        errorCode: null,
        errorMessage: null,
        summary: "Recovered after gateway retry.",
      });
    const retryEvents: Array<{ retryAttempt: number; delayMs: number }> = [];

    const result = await executeOpenClawGatewayDispatchWithRetry({
      agent: { adapterType: "openclaw_gateway" },
      execute,
      retryDelaysMs: [0, 0, 0],
      onRetry: (event) => {
        retryEvents.push({ retryAttempt: event.retryAttempt, delayMs: event.delayMs });
      },
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.exitCode).toBe(0);
    expect(retryEvents).toEqual([
      { retryAttempt: 1, delayMs: 0 },
      { retryAttempt: 2, delayMs: 0 },
    ]);
  });

  it("stops after all OpenClaw gateway dispatch retries are exhausted", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      timedOut: false,
      errorCode: "openclaw_gateway_request_failed",
      errorMessage: "gateway request failed",
    });
    const retryEvents: number[] = [];

    const result = await executeOpenClawGatewayDispatchWithRetry({
      agent: { adapterType: "openclaw_gateway" },
      execute,
      retryDelaysMs: [0, 0, 0],
      onRetry: (event) => retryEvents.push(event.retryAttempt),
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(result.errorCode).toBe("openclaw_gateway_request_failed");
    expect(retryEvents).toEqual([1, 2, 3]);
  });
});
