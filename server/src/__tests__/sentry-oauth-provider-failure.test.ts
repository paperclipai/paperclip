import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const BACKEND_DSN_ENV = "SENTRY_DSN_BACKEND";
const originalBackendDsn = process.env[BACKEND_DSN_ENV];

afterEach(() => {
  if (originalBackendDsn === undefined) delete process.env[BACKEND_DSN_ENV];
  else process.env[BACKEND_DSN_ENV] = originalBackendDsn;
  vi.doUnmock("@sentry/node");
  vi.doUnmock("../peer-version-check.js");
});

describe("captureException OAuth provider failures", () => {
  it("adds only the provider status and allowlisted error label to that event", async () => {
    process.env[BACKEND_DSN_ENV] = "https://fixture@example.com/1";
    const captureException = vi.fn((_error: unknown, _hint?: unknown) => "event-id");
    vi.doMock("@sentry/node", () => ({
      getClient: () => ({ on: vi.fn() }),
      init: vi.fn(),
      captureException,
      close: vi.fn(async () => true),
      httpIntegration: vi.fn((options: unknown) => ({ name: "Http", ...(options as object) })),
      onUnhandledRejectionIntegration: vi.fn((options: unknown) => ({ name: "OnUnhandledRejection", ...(options as object) })),
    }));
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.resetModules();
    const sentry = await import("../sentry.js");
    const { recordOAuthProviderFailure } = await import("../services/tool-access/oauth/provider-failure-diagnostics.js");
    await sentry.sentryReady;

    const error = recordOAuthProviderFailure(
      new HttpError(502, "OAuth dynamic client registration failed", { registrationUrl: "https://private.example.test/register" }),
      { operation: "dynamic_client_registration", httpStatus: 400, providerError: null },
    );
    sentry.captureException(error, { runId: "run-1" });
    const unrelated = new Error("unrelated");
    sentry.captureException(unrelated);

    expect(captureException.mock.calls[0]).toEqual([
      error,
      {
        tags: { run_id: "run-1", oauth_operation: "dynamic_client_registration", oauth_provider_status: "400" },
        contexts: { oauth_provider_failure: { operation: "dynamic_client_registration", httpStatus: 400, providerError: null } },
        fingerprint: ["{{ default }}"],
      },
    ]);
    expect(JSON.stringify(captureException.mock.calls[0]![1])).not.toContain("private");
    expect(captureException.mock.calls[1]).toEqual([unrelated]);
  });
});
