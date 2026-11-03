import { describe, expect, it } from "vitest";
import { resolveSentryDsns } from "../sentry-dsn.js";

const FRONTEND_DSN = "https://public-frontend@o0.ingest.sentry.io/1";
const BACKEND_DSN = "https://public-backend@o0.ingest.sentry.io/2";
const LEGACY_DSN = "https://public-legacy@o0.ingest.sentry.io/3";

describe("resolveSentryDsns", () => {
  it("resolves both fields to null when no variable is set", () => {
    const result = resolveSentryDsns({});

    expect(result).toEqual({ frontend: null, backend: null, legacyFallbackUsed: false });
  });

  it("uses the legacy value for both fields when only SENTRY_DSN is set", () => {
    const result = resolveSentryDsns({ SENTRY_DSN: LEGACY_DSN });

    expect(result).toEqual({ frontend: LEGACY_DSN, backend: LEGACY_DSN, legacyFallbackUsed: true });
  });

  it("resolves only the frontend field when only SENTRY_DSN_FRONTEND is set", () => {
    const result = resolveSentryDsns({ SENTRY_DSN_FRONTEND: FRONTEND_DSN });

    expect(result).toEqual({ frontend: FRONTEND_DSN, backend: null, legacyFallbackUsed: false });
  });

  it("resolves only the backend field when only SENTRY_DSN_BACKEND is set", () => {
    const result = resolveSentryDsns({ SENTRY_DSN_BACKEND: BACKEND_DSN });

    expect(result).toEqual({ frontend: null, backend: BACKEND_DSN, legacyFallbackUsed: false });
  });

  it("resolves each field to its own value when both specific variables are set", () => {
    const result = resolveSentryDsns({
      SENTRY_DSN_FRONTEND: FRONTEND_DSN,
      SENTRY_DSN_BACKEND: BACKEND_DSN,
    });

    expect(result).toEqual({ frontend: FRONTEND_DSN, backend: BACKEND_DSN, legacyFallbackUsed: false });
  });

  it("prefers the specific variables over SENTRY_DSN when all three are set", () => {
    const result = resolveSentryDsns({
      SENTRY_DSN_FRONTEND: FRONTEND_DSN,
      SENTRY_DSN_BACKEND: BACKEND_DSN,
      SENTRY_DSN: LEGACY_DSN,
    });

    expect(result).toEqual({ frontend: FRONTEND_DSN, backend: BACKEND_DSN, legacyFallbackUsed: false });
  });

  it("falls back to the legacy value for a component whose specific variable is an empty string", () => {
    const result = resolveSentryDsns({ SENTRY_DSN_FRONTEND: "", SENTRY_DSN: LEGACY_DSN });

    expect(result).toEqual({ frontend: LEGACY_DSN, backend: LEGACY_DSN, legacyFallbackUsed: true });
  });

  it("treats an empty SENTRY_DSN as absent when no specific variable is set", () => {
    const result = resolveSentryDsns({ SENTRY_DSN: "" });

    expect(result).toEqual({ frontend: null, backend: null, legacyFallbackUsed: false });
  });
});
