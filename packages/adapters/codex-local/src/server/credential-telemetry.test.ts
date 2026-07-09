import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bucketCodexLastRefreshAge,
  buildCodexCredentialTelemetryDimensions,
  classifyCodexAuthRefreshFailure,
  readCodexCredentialTelemetrySnapshot,
} from "./credential-telemetry.js";

describe("Codex credential telemetry", () => {
  it("classifies refresh-token auth failures without returning raw error strings", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "provider error: refresh_token_reused" })).toBe(
      "refresh_token_reused",
    );
    expect(classifyCodexAuthRefreshFailure({ stderr: "OAuth failed: refresh token expired" })).toBe(
      "refresh_token_expired",
    );
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "chatgpt wham api returned 401" })).toBe(
      "refresh_token_invalidated",
    );
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "model is at capacity" })).toBeNull();
  });

  it("buckets last_refresh into the approved low-cardinality buckets", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");

    expect(bucketCodexLastRefreshAge("2026-07-09T11:30:00.000Z", now)).toBe("lt_1h");
    expect(bucketCodexLastRefreshAge("2026-07-03T12:00:00.000Z", now)).toBe("lt_8d");
    expect(bucketCodexLastRefreshAge("2026-06-30T12:00:00.000Z", now)).toBe("gte_8d");
    expect(bucketCodexLastRefreshAge(null, now)).toBe("missing");
    expect(bucketCodexLastRefreshAge("not-a-date", now)).toBe("missing");
  });

  it("emits only derived credential dimensions and never token or account material", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-telemetry-"));
    try {
      const codexHome = path.join(root, "codex-home");
      await fs.mkdir(codexHome, { recursive: true });
      const refreshToken = "refresh-token-fixture-secret";
      const accessToken = "access-token-fixture-secret";
      const idToken = "id-token-fixture-secret";
      const accountId = "account-id-fixture-secret";
      const email = "codex-user-fixture@example.com";

      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            refresh_token: refreshToken,
            access_token: accessToken,
            id_token: idToken,
            account_id: accountId,
          },
          last_refresh: "2026-07-09T11:30:00.000Z",
          profile: { email },
        }),
        "utf8",
      );

      const seedSnapshot = await readCodexCredentialTelemetrySnapshot(
        codexHome,
        new Date("2026-07-09T12:00:00.000Z"),
      );

      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            refresh_token: "rotated-refresh-token-fixture-secret",
            access_token: accessToken,
            id_token: idToken,
            account_id: accountId,
          },
          last_refresh: "2026-07-09T11:40:00.000Z",
          profile: { email },
        }),
        "utf8",
      );
      const postRunSnapshot = await readCodexCredentialTelemetrySnapshot(
        codexHome,
        new Date("2026-07-09T12:00:00.000Z"),
      );

      const telemetry = buildCodexCredentialTelemetryDimensions({
        seedSource: "host_file",
        seedSnapshot,
        postRunSnapshot,
        failureClass: classifyCodexAuthRefreshFailure({
          errorMessage: `refresh_token_reused for ${refreshToken}`,
        }),
      });
      const serialized = JSON.stringify(telemetry);

      expect(telemetry).toEqual({
        seedSource: "host_file",
        lastRefreshAgeBucket: "lt_1h",
        rotationsDetected: true,
        failureClass: "refresh_token_reused",
      });
      for (const secret of [
        refreshToken,
        "rotated-refresh-token-fixture-secret",
        accessToken,
        idToken,
        accountId,
        email,
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
