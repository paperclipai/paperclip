import { describe, expect, it } from "vitest";
import { redactEventPayload, REDACTED_EVENT_VALUE } from "../redaction.js";

describe("redactEventPayload — OAuth secret keys (regression for /api/companies/:id/agents leak)", () => {
  it("redacts client_secret, refresh_token, id_token in adapterConfig.env without touching plain identifiers", () => {
    const adapterConfig = {
      adapterType: "openclaw_gateway",
      cwd: "/Users/agent/work",
      env: {
        GOOGLE_CLIENT_ID: "opaque-client-id-abc",
        GOOGLE_CLIENT_SECRET: "GOCSPX-supersecretvalue",
        GOOGLE_REFRESH_TOKEN: "1//0gREFRESHvalue",
        GOOGLE_ID_TOKEN: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        GOOGLE_API_KEY: "AIzaSyAINTHE_OPEN",
        DEBUG_FLAG: "true",
        LOG_LEVEL: "info",
      },
    };

    const out = redactEventPayload(adapterConfig);
    const env = (out as { env: Record<string, string> }).env;

    expect(env.GOOGLE_CLIENT_ID).toBe("opaque-client-id-abc");
    expect(env.GOOGLE_CLIENT_SECRET).toBe(REDACTED_EVENT_VALUE);
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(REDACTED_EVENT_VALUE);
    expect(env.GOOGLE_ID_TOKEN).toBe(REDACTED_EVENT_VALUE);
    expect(env.GOOGLE_API_KEY).toBe(REDACTED_EVENT_VALUE);
    expect(env.DEBUG_FLAG).toBe("true");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("redacts top-level client_secret and refresh_token keys", () => {
    const payload = {
      client_secret: "GOCSPX-abc",
      refresh_token: "1//0gtok",
      harmless_flag: "ok",
    };
    const out = redactEventPayload(payload) as Record<string, string>;
    expect(out.client_secret).toBe(REDACTED_EVENT_VALUE);
    expect(out.refresh_token).toBe(REDACTED_EVENT_VALUE);
    expect(out.harmless_flag).toBe("ok");
  });
});
