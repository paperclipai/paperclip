import { describe, expect, it } from "vitest";
import { redactSecretsInText, redactTranscriptEntryPaths } from "./log-redaction.js";

describe("redactSecretsInText", () => {
  it("redacts a bare DATABASE_URL env-dump password", () => {
    const sample =
      "DATABASE_URL=postgres://paperclip:s3cr3tExamplePasswordValue32c@paperclip.example.rds.amazonaws.com:5432/paperclip?sslmode=require";
    const out = redactSecretsInText(sample);
    expect(out).not.toContain("s3cr3tExamplePasswordValue32c");
    expect(out).toMatch(/_REDACTED>/);
  });

  it("redacts an inline connection-string password with no env-name anchor", () => {
    const sample = "connect via postgresql://svc:MyInlinePass99word@db.internal:5432/app";
    const out = redactSecretsInText(sample);
    expect(out).not.toContain("MyInlinePass99word");
    expect(out).toContain("<DB_PASSWORD_REDACTED>");
    expect(out).toContain("db.internal");
    expect(out).toContain("svc:");
  });

  it("redacts NAME=value env dumps for the sensitive family", () => {
    const cases: Array<[string, string]> = [
      ["K3_API_KEY", "sk-k3-AbCdEf0123456789xyz"],
      ["OWM_API_KEY", "3f0011223344556677889900aabbccdd"],
      ["PJM_API_KEY", "9e00112233445566778899aabbccdd0a"],
      ["UKPN_API_KEY", "3d00112233445566778899aabbccdd79"],
      ["URDB_API_KEY", "aBcDeF0123456789aBcDeF0123456789xyzw"],
      ["NORDPOOL_USERNAME", "APICLIENT_EXAMPLE_ID"],
      ["PAPERCLIP_API_KEY", "pc_example_0123456789abcdef0123"],
      ["ENTSOE_API_KEY", "abcd1234-ef56-7890-abcd-ef1234567890"],
      ["GRIDSTATUS_API_KEY", "421518443c3b4e13a544872d91c59f0a"],
    ];
    for (const [name, val] of cases) {
      const sample = `PWD=/x\n${name}=${val}\nHOME=/y`;
      const out = redactSecretsInText(sample);
      expect(out, name).not.toContain(val);
      expect(out, name).toContain("_REDACTED>");
    }
  });

  it("redacts JSON and NDJSON-escaped env-dump forms", () => {
    const json = '{"K3_API_KEY": "sk-k3-AbCdEf0123456789xyz"}';
    expect(redactSecretsInText(json)).not.toContain("sk-k3-AbCdEf0123456789xyz");
    const escaped = '\\"PJM_API_KEY\\": \\"9e00112233445566778899aabbccdd0a\\"';
    expect(redactSecretsInText(escaped)).not.toContain("9e00112233445566778899aabbccdd0a");
  });

  it("redacts Anthropic and GitHub App token prefixes without a name anchor", () => {
    const anthropic = "token=sk-ant-api03-AbCdEf0123456789_-ghIJKlmnop";
    expect(redactSecretsInText(anthropic)).not.toContain("sk-ant-api03-AbCdEf");
    const ghs = "hdr=ghs_AbCdEf0123456789AbCdEf0123456789ABCD";
    expect(redactSecretsInText(ghs)).not.toContain("ghs_AbCdEf0123456789");
  });

  it("does not redact key names mentioned in prose", () => {
    const sample = "We rotated PJM_API_KEY and DATABASE_URL after the leak.";
    expect(redactSecretsInText(sample)).toBe(sample);
  });

  it("is idempotent", () => {
    const sample =
      "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_-ghIJKlmnop\nPJM_API_KEY=9e00112233445566778899aabbccdd0a";
    const once = redactSecretsInText(sample);
    expect(redactSecretsInText(once)).toBe(once);
  });
});

describe("redactTranscriptEntryPaths", () => {
  it("redacts DATABASE_URL in stdout and tool_result before persist", () => {
    const leak =
      "DATABASE_URL=postgres://paperclip:s3cr3tExamplePasswordValue32c@host.example:5432/db";
    const stdout = redactTranscriptEntryPaths({ kind: "stdout", ts: "t", text: leak });
    if (stdout.kind !== "stdout") throw new Error("expected stdout");
    expect(stdout.text).not.toContain("s3cr3tExamplePasswordValue32c");

    const tool = redactTranscriptEntryPaths({
      kind: "tool_result",
      ts: "t",
      toolUseId: "1",
      content: leak,
      isError: false,
    });
    if (tool.kind !== "tool_result") throw new Error("expected tool_result");
    expect(tool.content).not.toContain("s3cr3tExamplePasswordValue32c");
  });

  it("redacts env dumps inside tool_call input strings", () => {
    const entry = redactTranscriptEntryPaths({
      kind: "tool_call",
      ts: "t",
      name: "bash",
      input: { command: "echo PAPERCLIP_API_KEY=pc_example_0123456789abcdef0123" },
    });
    if (entry.kind !== "tool_call") throw new Error("expected tool_call");
    expect(JSON.stringify(entry.input)).not.toContain("pc_example_0123456789abcdef0123");
  });
});
