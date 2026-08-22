import { describe, expect, it } from "vitest";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import {
  buildZeroTokenDiagnosticComment,
  isZeroTokenDiagnosticMetadata,
  isZeroTokenTermination,
  sniffOverloadCause,
  ZERO_TOKEN_DIAGNOSTIC_KIND,
} from "./heartbeat-zero-token-diagnostic.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("isZeroTokenTermination", () => {
  it("returns false for null/undefined usage", () => {
    expect(isZeroTokenTermination(null)).toBe(false);
    expect(isZeroTokenTermination(undefined)).toBe(false);
  });

  it("returns true only when BOTH input and output are zero", () => {
    expect(isZeroTokenTermination({ inputTokens: 0, outputTokens: 0 })).toBe(true);
  });

  it("returns false when output > 0 (guards against cached low-usage false positives)", () => {
    expect(isZeroTokenTermination({ inputTokens: 0, outputTokens: 3 })).toBe(false);
    expect(isZeroTokenTermination({ inputTokens: 1000, outputTokens: 1 })).toBe(false);
  });

  it("returns false when only input > 0", () => {
    expect(isZeroTokenTermination({ inputTokens: 5, outputTokens: 0 })).toBe(false);
  });

  it("treats a cached-only-but-zero-output run as a zero-token termination", () => {
    // Cached input but no real input and no output => nothing was produced.
    expect(isZeroTokenTermination({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 500 })).toBe(true);
  });

  it("coerces missing/non-numeric token fields to zero", () => {
    expect(isZeroTokenTermination({})).toBe(true);
    expect(isZeroTokenTermination({ inputTokens: undefined, outputTokens: undefined })).toBe(true);
  });
});

describe("sniffOverloadCause", () => {
  it("detects the 529 gateway overload marker", () => {
    expect(sniffOverloadCause(["HTTP 529 service overloaded"])).toBe("529");
  });

  it("detects 'overloaded'", () => {
    expect(sniffOverloadCause(["upstream overloaded, retry later"])).toMatch(/overload/i);
  });

  it("detects rate-limit / capacity markers", () => {
    expect(sniffOverloadCause(["", "request was rate limited"])).toMatch(/rate limit/i);
    expect(sniffOverloadCause(["no capacity available"])).toMatch(/capacity/i);
  });

  it("returns null when no marker is present", () => {
    expect(sniffOverloadCause(["all good", "ran to completion"])).toBeNull();
    expect(sniffOverloadCause([null, "", undefined])).toBeNull();
    expect(sniffOverloadCause([])).toBeNull();
  });

  it("returns the marker from the first matching source", () => {
    expect(sniffOverloadCause(["error: 529", "also overloaded"])).toBe("529");
  });
});

describe("buildZeroTokenDiagnosticComment", () => {
  it("names the cause in the body when a marker is provided", () => {
    const { body } = buildZeroTokenDiagnosticComment({
      runId: UUID,
      provider: "zai",
      model: "glm-5.2",
      usage: { inputTokens: 0, outputTokens: 0 },
      cause: "529",
    });
    expect(body).toContain("0 input + 0 output tokens");
    expect(body).toContain("`529`");
    expect(body).toContain("succeeded");
  });

  it("falls back to a symptom line when no cause marker was found", () => {
    const { body } = buildZeroTokenDiagnosticComment({
      runId: UUID,
      usage: { inputTokens: 0, outputTokens: 0 },
      cause: null,
    });
    expect(body).toContain("No specific overload marker");
  });

  it("produces a warning system_notice presentation", () => {
    const { presentation } = buildZeroTokenDiagnosticComment({
      runId: UUID,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(presentation.kind).toBe("system_notice");
    expect(presentation.tone).toBe("warning");
  });

  it("stamps the diagnostic-kind marker and source run id on the metadata", () => {
    const { metadata } = buildZeroTokenDiagnosticComment({
      runId: UUID,
      provider: "zai",
      model: "glm-5.2",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 12 },
      cause: "529",
    });
    expect(metadata.version).toBe(1);
    expect(metadata.sourceRunId).toBe(UUID);
    expect(isZeroTokenDiagnosticMetadata(metadata)).toBe(true);
    const section = metadata.sections[0];
    const causeRow = section.rows.find((r) => r.type === "key_value" && r.label === "Cause");
    expect(causeRow && causeRow.type === "key_value" && causeRow.value).toBe("529");
    const cachedRow = section.rows.find((r) => r.type === "key_value" && r.label === "Cached input tokens");
    expect(cachedRow && cachedRow.type === "key_value" && cachedRow.value).toBe("12");
  });
});

describe("isZeroTokenDiagnosticMetadata (dedup predicate)", () => {
  const diagnosticMetadata: IssueCommentMetadata = buildZeroTokenDiagnosticComment({
    runId: UUID,
    usage: { inputTokens: 0, outputTokens: 0 },
  }).metadata;

  it("returns true for metadata built by buildZeroTokenDiagnosticComment", () => {
    expect(isZeroTokenDiagnosticMetadata(diagnosticMetadata)).toBe(true);
  });

  it("returns false for null/undefined metadata", () => {
    expect(isZeroTokenDiagnosticMetadata(null)).toBe(false);
    expect(isZeroTokenDiagnosticMetadata(undefined)).toBe(false);
  });

  it("returns false for unrelated metadata (e.g. a recovery-action notice)", () => {
    const recoveryMetadata: IssueCommentMetadata = {
      version: 1,
      sections: [
        {
          title: "Recovery",
          rows: [{ type: "key_value", label: "Recovery action", value: "22222222-2222-4222-8222-222222222222" }],
        },
      ],
    };
    expect(isZeroTokenDiagnosticMetadata(recoveryMetadata)).toBe(false);
  });

  it("returns false when the kind row has a different value", () => {
    const impostor: IssueCommentMetadata = {
      version: 1,
      sections: [
        {
          title: "X",
          rows: [{ type: "key_value", label: "Diagnostic kind", value: "something_else" }],
        },
      ],
    };
    expect(isZeroTokenDiagnosticMetadata(impostor)).toBe(false);
    expect(ZERO_TOKEN_DIAGNOSTIC_KIND).toBe("zero_token_run");
  });
});
