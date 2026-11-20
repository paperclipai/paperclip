import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { createOAuthClientProtocol } from "../services/tool-access/oauth/client.js";
import { oauthProviderFailureDiagnosticsFor } from "../services/tool-access/oauth/provider-failure-diagnostics.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

const PROVIDER_CANARY = "provider-body-canary-7c1e";

function createApp(status: number, body: unknown) {
  const { requestOAuthClientRegistration } = createOAuthClientProtocol({
    assertOAuthEndpointUrl: (_kind, value) => String(value),
    fetchRemoteHttpUrl: async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
  const app = express();
  app.post("/register", async (_req, res) => {
    res.json(await requestOAuthClientRegistration({
      endpoints: {
        provider: "fixture",
        scopes: [],
        authorizationUrl: "https://auth.example.test/authorize",
        tokenUrl: "https://auth.example.test/token",
        registrationUrl: "https://auth.example.test/register",
      },
      redirectUri: "https://paperclip.example.test/api/tools/oauth/callback",
    }));
  });
  app.use(errorHandler);
  return app;
}

describe("OAuth dynamic client registration failure reporting", () => {
  beforeEach(() => captureExceptionMock.mockReset());

  it.each([401, 403, 404, 429, 500, 503])(
    "answers a provider-side %i with a 502 and no crash report",
    async (status) => {
      const res = await request(createApp(status, { message: PROVIDER_CANARY })).post("/register");

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        error: "OAuth dynamic client registration failed",
        code: "oauth_dynamic_client_registration_failed",
        details: { code: "oauth_dynamic_client_registration_failed", providerError: null, status },
      });
      expect(JSON.stringify(res.body)).not.toContain(PROVIDER_CANARY);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    },
  );

  it("still reports a 400 rejection with only its status and allowlisted error label", async () => {
    const res = await request(createApp(400, { error: "invalid_client_metadata", error_description: PROVIDER_CANARY }))
      .post("/register");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      error: "The authorization server rejected Paperclip's client registration details.",
      details: { providerError: "invalid_client_metadata", status: 400 },
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const reported = captureExceptionMock.mock.calls[0]![0];
    expect(oauthProviderFailureDiagnosticsFor(reported)).toEqual({
      operation: "dynamic_client_registration",
      httpStatus: 400,
      providerError: "invalid_client_metadata",
    });
    expect(JSON.stringify(oauthProviderFailureDiagnosticsFor(reported))).not.toContain(PROVIDER_CANARY);
  });

  it("still reports a successful response with unusable client metadata", async () => {
    const res = await request(createApp(201, { redirect_uris: [] })).post("/register");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "oauth_dcr_response_invalid" });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(oauthProviderFailureDiagnosticsFor(captureExceptionMock.mock.calls[0]![0])).toBeNull();
  });
});
