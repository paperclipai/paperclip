import { describe, expect, it } from "vitest";
import { buildWakeText, redactForLog, resolveSessionKey } from "./execute.js";

const baseWakePayload = {
  runId: "run-123",
  agentId: "agent-456",
  companyId: "company-789",
  taskId: "task-abc",
  issueId: "issue-abc",
  wakeReason: "heartbeat_timer",
  wakeCommentId: null,
  approvalId: null,
  approvalStatus: null,
  issueIds: [],
};

const baseEnv = {
  PAPERCLIP_RUN_ID: "run-123",
  PAPERCLIP_AGENT_ID: "agent-456",
  PAPERCLIP_COMPANY_ID: "company-789",
  PAPERCLIP_API_URL: "http://127.0.0.1:3101",
};

describe("buildWakeText (PR #6121 per-run JWT)", () => {
  it("renders PAPERCLIP_API_KEY=<jwt> inline when paperclipApiKey is supplied", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const text = buildWakeText(baseWakePayload, baseEnv, "", {
      paperclipApiKey: jwt,
    });
    expect(text).toContain(`PAPERCLIP_API_KEY=${jwt}`);
    expect(text).toContain(
      "Use this PAPERCLIP_API_KEY for this wake only. Never print it, echo it, or include it in issue comments.",
    );
    expect(text).not.toContain("Load PAPERCLIP_API_KEY from");
  });

  it("falls back to the file-bootstrap instruction when no paperclipApiKey is supplied", () => {
    const claimedPath = "/some/explicit/claimed-key.json";
    const text = buildWakeText(baseWakePayload, baseEnv, "", {
      claimedApiKeyPath: claimedPath,
    });
    expect(text).toContain(`PAPERCLIP_API_KEY=<token from ${claimedPath}>`);
    expect(text).toContain(`Load PAPERCLIP_API_KEY from ${claimedPath}`);
    expect(text).not.toMatch(/PAPERCLIP_API_KEY=eyJ/);
  });

  it("treats empty-string paperclipApiKey as missing and falls back", () => {
    const text = buildWakeText(baseWakePayload, baseEnv, "", {
      paperclipApiKey: "",
    });
    expect(text).toContain("Load PAPERCLIP_API_KEY from");
    expect(text).not.toMatch(/PAPERCLIP_API_KEY=\s*$/m);
  });
});

describe("redactForLog (PR #6121 JWT-in-message redaction)", () => {
  it("strips PAPERCLIP_API_KEY=<value> from a message field", () => {
    const result = redactForLog(
      {
        message: "PAPERCLIP_API_KEY=eyJhbGciOiJIUzI1NiJ9.payload.signature\nrest of prompt",
      },
      [],
      0,
    ) as Record<string, string>;
    expect(result.message).toContain("PAPERCLIP_API_KEY=[redacted]");
    expect(result.message).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.signature");
    expect(result.message).toContain("rest of prompt");
  });

  it("leaves messages without PAPERCLIP_API_KEY unchanged (modulo truncation)", () => {
    const result = redactForLog({ message: "plain payload no secret here" }, [], 0) as Record<
      string,
      string
    >;
    expect(result.message).toBe("plain payload no secret here");
  });

  it("does not apply the JWT regex to non-'message' keys", () => {
    // Other string keys go through normal truncation; the inline-JWT replace branch
    // is gated to the 'message' key path, so a top-level string is unaffected.
    const result = redactForLog("PAPERCLIP_API_KEY=eyJraw");
    expect(result).toBe("PAPERCLIP_API_KEY=eyJraw");
  });
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});
