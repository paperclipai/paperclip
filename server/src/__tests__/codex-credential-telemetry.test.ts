import { describe, expect, it, vi } from "vitest";
import {
  CODEX_CREDENTIAL_TELEMETRY_RESULT_KEY,
} from "@paperclipai/adapter-codex-local/server";
import type { TelemetryClient } from "@paperclipai/shared/telemetry";
import { emitCodexCredentialTelemetryForRun } from "../services/codex-credential-telemetry.js";

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn(),
  } as unknown as TelemetryClient;
}

function trackMock(client: TelemetryClient): ReturnType<typeof vi.fn> {
  return client.track as unknown as ReturnType<typeof vi.fn>;
}

describe("emitCodexCredentialTelemetryForRun", () => {
  it("adds query dimensions and ignores token/account material", () => {
    const client = createClient();
    const refreshToken = "refresh-token-fixture-secret";
    const accessToken = "access-token-fixture-secret";
    const idToken = "id-token-fixture-secret";
    const openAiKey = "sk-openai-fixture-secret";
    const accountId = "account-id-fixture-secret";
    const email = "codex-user-fixture@example.com";

    emitCodexCredentialTelemetryForRun({
      telemetryClient: client,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        adapterType: "codex_local",
      },
      resultJson: {
        [CODEX_CREDENTIAL_TELEMETRY_RESULT_KEY]: {
          seedSource: "host_file",
          lastRefreshAgeBucket: "lt_8d",
          rotationsDetected: true,
          failureClass: "refresh_token_expired",
          refresh_token: refreshToken,
          access_token: accessToken,
          id_token: idToken,
          OPENAI_API_KEY: openAiKey,
          account_id: accountId,
          email,
        },
      },
    });

    expect(client.track).toHaveBeenCalledWith("codex.credential_health", {
      company_id: "company-1",
      agent_id: "agent-1",
      adapter_type: "codex_local",
      failure_class: "refresh_token_expired",
      seed_source: "host_file",
      last_refresh_age_bucket: "lt_8d",
      rotations_detected: true,
    });
    const payload = JSON.stringify(trackMock(client).mock.calls);
    for (const secret of [refreshToken, accessToken, idToken, openAiKey, accountId, email]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("does not emit unknown dimensions from malformed adapter results", () => {
    const client = createClient();

    emitCodexCredentialTelemetryForRun({
      telemetryClient: client,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        adapterType: "codex_local",
      },
      resultJson: {
        [CODEX_CREDENTIAL_TELEMETRY_RESULT_KEY]: {
          seedSource: "host_file",
          lastRefreshAgeBucket: "lt_8d",
          rotationsDetected: true,
          failureClass: "new-unreviewed-class",
        },
      },
    });

    expect(client.track).toHaveBeenCalledWith("codex.credential_health", {
      company_id: "company-1",
      agent_id: "agent-1",
      adapter_type: "codex_local",
      seed_source: "host_file",
      last_refresh_age_bucket: "lt_8d",
      rotations_detected: true,
    });
    const [, dimensions] = trackMock(client).mock.calls.at(-1)!;
    expect(Object.keys(dimensions as Record<string, unknown>).sort()).toEqual([
      "adapter_type",
      "agent_id",
      "company_id",
      "last_refresh_age_bucket",
      "rotations_detected",
      "seed_source",
    ]);
  });
});
