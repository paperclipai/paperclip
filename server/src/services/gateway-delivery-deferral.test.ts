import { describe, expect, it } from "vitest";
import {
  MAX_GATEWAY_DELIVERY_HOLD_MS,
  readGatewayDeliveryDeferralUntil,
  resolveGatewayDeliveryDeferral,
} from "./gateway-delivery-deferral.js";

const refusedBeforeStart = {
  kind: "bootstrap",
  providerWorkStarted: false,
} as const;

describe("gateway delivery deferral", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const laterNow = new Date("2026-09-29T12:00:10.000Z");
  const runCreatedAt = new Date("2026-09-29T12:00:00.000Z");

  it("reads the Hermes delta-seconds Retry-After as seconds after the run started", () => {
    const until = readGatewayDeliveryDeferralUntil({
      retryNotBefore: "1",
      runCreatedAt,
      now,
    });
    expect(until?.toISOString()).toBe("2026-09-29T12:00:01.000Z");
  });

  it("uses an absolute Retry-After timestamp as it is", () => {
    const until = readGatewayDeliveryDeferralUntil({
      retryNotBefore: "2026-09-29T12:05:00.000Z",
      runCreatedAt,
      now,
    });
    expect(until?.toISOString()).toBe("2026-09-29T12:05:00.000Z");
  });

  it("defers a hint that already elapsed instead of re-dispatching immediately", () => {
    const until = readGatewayDeliveryDeferralUntil({
      retryNotBefore: "2026-09-29T11:59:00.000Z",
      runCreatedAt,
      now: laterNow,
    });
    expect(until?.toISOString()).toBe("2026-09-29T12:00:11.000Z");
  });

  it("defers a delta-seconds hint that expired before the refusal was persisted", () => {
    const until = readGatewayDeliveryDeferralUntil({
      retryNotBefore: "1",
      runCreatedAt,
      now: laterNow,
    });
    expect(until?.toISOString()).toBe("2026-09-29T12:00:11.000Z");
  });

  it("defers a zero-second hint by the minimum delay", () => {
    const until = readGatewayDeliveryDeferralUntil({
      retryNotBefore: "0",
      runCreatedAt,
      now: laterNow,
    });
    expect(until?.toISOString()).toBe("2026-09-29T12:00:11.000Z");
  });

  it("caps an implausible hint at the hold cap", () => {
    const until = readGatewayDeliveryDeferralUntil({
      retryNotBefore: "2026-10-02T12:00:00.000Z",
      runCreatedAt,
      now,
    });
    expect(until?.getTime()).toBe(now.getTime() + MAX_GATEWAY_DELIVERY_HOLD_MS);
  });

  it("has no window without a readable hint", () => {
    expect(
      readGatewayDeliveryDeferralUntil({
        retryNotBefore: null,
        runCreatedAt,
        now,
      }),
    ).toBeNull();
    expect(
      readGatewayDeliveryDeferralUntil({
        retryNotBefore: "not-a-date",
        runCreatedAt,
        now,
      }),
    ).toBeNull();
  });

  it("defers a refusal the gateway answered with 429 and a hint", () => {
    const deferral = resolveGatewayDeliveryDeferral({
      errorCode: "hermes_gateway_rate_limited",
      executionRecovery: refusedBeforeStart,
      retryNotBefore: "1",
      runCreatedAt,
      now,
    });
    expect(deferral).toEqual({
      errorCode: "hermes_gateway_rate_limited",
      retryNotBefore: "1",
      until: new Date("2026-09-29T12:00:01.000Z"),
    });
  });

  it("keeps a transport failure a failure when no provider-work evidence was claimed", () => {
    expect(
      resolveGatewayDeliveryDeferral({
        errorCode: "hermes_gateway_connect_failed",
        executionRecovery: undefined,
        retryNotBefore: "2026-09-29T12:05:00.000Z",
        runCreatedAt,
        now,
      }),
    ).toBeNull();
  });

  it("keeps a refusal without a hint a failure", () => {
    expect(
      resolveGatewayDeliveryDeferral({
        errorCode: "hermes_gateway_rate_limited",
        executionRecovery: refusedBeforeStart,
        retryNotBefore: null,
        runCreatedAt,
        now,
      }),
    ).toBeNull();
  });

  it("ignores non-gateway failures", () => {
    expect(
      resolveGatewayDeliveryDeferral({
        errorCode: "adapter_failed",
        executionRecovery: refusedBeforeStart,
        retryNotBefore: "1",
        runCreatedAt,
        now,
      }),
    ).toBeNull();
  });
});
