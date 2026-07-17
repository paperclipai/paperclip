import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_QUARANTINE_MARKER,
  redactTranscriptDiagnosticValue,
  secureTranscriptPayload,
  secureTranscriptText,
  transcriptCredentialQuarantineEnabled,
} from "../transcript-security.js";

const SYNTHETIC_CREDENTIAL = "ghp_000000000000000000000000000000000000";

describe("transcript credential security boundaries", () => {
  it("redacts and marks credential-shaped run-log records before persistence", () => {
    const result = secureTranscriptText(
      `tool output token=${SYNTHETIC_CREDENTIAL}`,
      "run_log",
    );

    expect(result.value).toContain(TRANSCRIPT_QUARANTINE_MARKER);
    expect(result.value).toContain("***REDACTED***");
    expect(result.value).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(result.metadata).toEqual({
      disposition: "quarantined",
      boundary: "run_log",
      detectorVersion: 1,
      matchCount: 1,
    });
    expect(JSON.stringify(result.metadata)).not.toContain(SYNTHETIC_CREDENTIAL);
  });

  it("emits metadata-only quarantine evidence for structured transcript records", () => {
    const result = secureTranscriptPayload(
      {
        event: "tool_result",
        output: `Authorization: Bearer ${SYNTHETIC_CREDENTIAL}`,
      },
      "run_event",
    );

    expect(JSON.stringify(result.value)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(result.value).toMatchObject({
      event: "tool_result",
      _paperclipTranscriptSecurity: {
        disposition: "quarantined",
        boundary: "run_event",
        detectorVersion: 1,
        matchCount: 1,
        marker: TRANSCRIPT_QUARANTINE_MARKER,
      },
    });
    expect(JSON.stringify(result.metadata)).not.toContain(SYNTHETIC_CREDENTIAL);
  });

  it("preserves secret metadata identifiers while redacting credential-shaped values", () => {
    const result = secureTranscriptPayload(
      {
        secretId: "11111111-1111-1111-1111-111111111111",
        secretName: "unbound-runtime-secret",
        output: SYNTHETIC_CREDENTIAL,
      },
      "run_summary",
    );

    expect(result.value).toMatchObject({
      secretId: "11111111-1111-1111-1111-111111111111",
      secretName: "unbound-runtime-secret",
      output: "***REDACTED***",
    });
    expect(result.metadata?.matchCount).toBe(1);
  });

  it("redacts legacy credential content at the normal diagnostic rendering boundary", () => {
    const rendered = redactTranscriptDiagnosticValue({
      error: `request failed with ${SYNTHETIC_CREDENTIAL}`,
      payload: {
        apiKey: SYNTHETIC_CREDENTIAL,
      },
    });

    expect(JSON.stringify(rendered)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(JSON.stringify(rendered)).toContain("***REDACTED***");
  });

  it("allows quarantine rollback without disabling capture-time redaction", () => {
    const result = secureTranscriptText(
      `token=${SYNTHETIC_CREDENTIAL}`,
      "run_log",
      { quarantineEnabled: false },
    );

    expect(result.metadata?.disposition).toBe("redacted");
    expect(result.value).not.toContain(TRANSCRIPT_QUARANTINE_MARKER);
    expect(result.value).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(result.value).toContain("***REDACTED***");
    expect(
      transcriptCredentialQuarantineEnabled({
        PAPERCLIP_TRANSCRIPT_CREDENTIAL_QUARANTINE: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
