import { describe, expect, it } from "vitest";
import {
  sanitizeInheritedPaperclipEnv,
  splitAdapterEnvForPersistence,
} from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

// acpx writes `sessionOptions.env` into the session record on disk and reads it back to
// rebuild the turn client for the next turn, and its own type doc says "Do not put secrets
// here; use authCredentials for credentials". Measured on a self-hosted deployment on
// 2026-08-21: a `SENTRY_AUTH_TOKEN` projected through the agent config showed up in clear
// text in the transcript, under `acpx > session_options > env`, on every run.
//
// Redacting at write time does NOT work: the value has to survive the round trip, or the
// next turn is handed `***REDACTED***` as a credential. Hence the split — the secret
// changes lane, not shape.
describe("splitAdapterEnvForPersistence", () => {
  it("keeps ordinary configuration persistable and moves every credential to the auth lane", () => {
    expect(splitAdapterEnvForPersistence({
      PATH: "/usr/bin",
      HOME: "/home/paperclip",
      PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/paperclip-run-1",
      SENTRY_AUTH_TOKEN: "sentry-secret",
      PAPERCLIP_API_KEY: "run-jwt",
      DATABASE_URL: "postgres://user:password@db/paperclip",
    })).toEqual({
      sessionEnv: {
        PATH: "/usr/bin",
        HOME: "/home/paperclip",
        PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/paperclip-run-1",
      },
      authCredentials: {
        SENTRY_AUTH_TOKEN: "sentry-secret",
        PAPERCLIP_API_KEY: "run-jwt",
        DATABASE_URL: "postgres://user:password@db/paperclip",
      },
    });
  });

  it("never leaves a credential value on the lane that gets written to disk", () => {
    const { sessionEnv } = splitAdapterEnvForPersistence({
      PATH: "/usr/bin",
      SENTRY_AUTH_TOKEN: "sentry-secret",
      SOME_PASSWORD: "pw",
      HTTP_AUTHORIZATION: "Bearer abc",
      SESSION_COOKIE: "sid=1",
    });
    expect(Object.values(sessionEnv)).toEqual(["/usr/bin"]);
  });

  it("splits without losing or duplicating a key", () => {
    const env = {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      SENTRY_AUTH_TOKEN: "sentry-secret",
      PAPERCLIP_API_KEY: "run-jwt",
    };
    const { sessionEnv, authCredentials } = splitAdapterEnvForPersistence(env);
    expect([...Object.keys(sessionEnv), ...Object.keys(authCredentials)].sort())
      .toEqual(Object.keys(env).sort());
    for (const [key, value] of Object.entries(env)) {
      expect(sessionEnv[key] ?? authCredentials[key]).toBe(value);
    }
  });
});
