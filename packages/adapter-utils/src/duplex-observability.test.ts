import { describe, expect, it } from "vitest";

import {
  DUPLEX_LOSS_REASONS,
  HTTP2_TELEMETRY_EVENT_NAMES,
  mapHttp2EventToDuplexLossReason,
  normalizeDuplexLossReason,
  normalizeDuplexProvider,
  type DuplexFallbackReason,
  type DuplexTransportValue,
} from "./duplex-observability.js";

describe("duplex observability: HTTP/2 event mapping (accepted security fix 7)", () => {
  it("test_http2_events_map_to_the_loss_taxonomy", () => {
    // Every closed HTTP/2 event name maps to a value from the existing,
    // closed DuplexLossReason set. The map reuses one taxonomy across every
    // transport, so no separate HTTP/2-only reason list exists.
    for (const event of HTTP2_TELEMETRY_EVENT_NAMES) {
      const reason = mapHttp2EventToDuplexLossReason(event);
      expect(DUPLEX_LOSS_REASONS).toContain(reason);
    }
    expect(mapHttp2EventToDuplexLossReason("session_error")).toBe("rpc_failure");
    expect(mapHttp2EventToDuplexLossReason("session_goaway")).toBe("transport_closed");
    expect(mapHttp2EventToDuplexLossReason("session_stall")).toBe("heartbeat_timeout");
    expect(mapHttp2EventToDuplexLossReason("write_error")).toBe("write_error");
    expect(mapHttp2EventToDuplexLossReason("transport_closed")).toBe("transport_closed");
    expect(mapHttp2EventToDuplexLossReason("channel_exit")).toBe("provider_exit");
  });

  it("test_an_unknown_telemetry_input_maps_to_other", () => {
    // An unknown event name, a raw provider error string, and a missing value
    // all map to `other`. No raw text ever reaches a sink through this map.
    expect(mapHttp2EventToDuplexLossReason("ECONNRESET: read failed at socket.js:42")).toBe("other");
    expect(mapHttp2EventToDuplexLossReason("some_future_event")).toBe("other");
    expect(mapHttp2EventToDuplexLossReason(null)).toBe("other");
    expect(mapHttp2EventToDuplexLossReason(undefined)).toBe("other");
    expect(mapHttp2EventToDuplexLossReason("")).toBe("other");
  });

  it("keeps the closed HTTP/2 event-name set to the seven named signals", () => {
    expect([...HTTP2_TELEMETRY_EVENT_NAMES].sort()).toEqual(
      [
        "session_error",
        "session_goaway",
        "session_stall",
        "write_error",
        "transport_closed",
        "channel_exit",
      ].sort(),
    );
  });
});

describe("duplex observability: closed transport and fallback-reason values", () => {
  it("accepts the http2 transport value and the preface_missing fallback reason", () => {
    // A type-level check: these string literals must widen to the exported
    // union types with no cast, so a drift in either union breaks the build.
    const transport: DuplexTransportValue = "http2";
    const fallbackReason: DuplexFallbackReason = "preface_missing";
    expect(transport).toBe("http2");
    expect(fallbackReason).toBe("preface_missing");
  });
});

describe("duplex observability: existing normalization stays intact", () => {
  it("still maps an unknown loss cause and an unknown provider key to their closed defaults", () => {
    expect(normalizeDuplexLossReason("not_a_real_reason")).toBe("other");
    expect(normalizeDuplexProvider("some-unlisted-plugin")).toBe("other");
  });
});
