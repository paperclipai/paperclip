import { describe, expect, it } from "vitest";
import { mcpErrorMessage } from "../services/mcp-error-message.js";

const fallback = "Remote MCP server returned an error";

describe("remote MCP error messages", () => {
  it("keeps useful protocol text and treats it as untrusted", () => {
    expect(mcpErrorMessage(fallback, { code: -32602, message: "Skill refunds was not found" }, {}))
      .toBe(`${fallback}. Upstream message (untrusted): Skill refunds was not found`);
  });

  it("removes opaque credentials and their encoded forms before clipping", () => {
    const secret = "opaque/value+credential";
    const message = `Invalid key ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret).slice(1, -1)}`;
    const result = mcpErrorMessage(fallback, { message }, { Authorization: `Bearer ${secret}` });
    expect(result).toContain("Invalid key [REDACTED]");
    expect(result).not.toContain(secret);
    expect(result).not.toContain(encodeURIComponent(secret));
    const long = mcpErrorMessage(fallback, { message: `${"x".repeat(990)} ${secret}` }, { "X-Custom": secret });
    expect(long).not.toContain("opaque");
    expect(long).toHaveLength(`${fallback}. Upstream message (untrusted): `.length + 1000);
    expect(long).toMatch(/\.\.\.$/);
  });

  it("uses existing pattern redaction and removes control characters", () => {
    const result = mcpErrorMessage(fallback, {
      message: "Bad arguments\n\u001b[31m TOKEN=some-private-value Authorization: Bearer other-private-value\u202e",
    }, {});
    expect(result).toContain("Bad arguments");
    expect(result).not.toMatch(/some-private-value|other-private-value|[\n\u001b\u202e]/);
  });

  it("omits all arbitrary data, including nested secrets and stacks", () => {
    expect(mcpErrorMessage(fallback, { message: "Invalid schema", data: {
      password: "never-reflect", stack: "internal-path", raw: "provider-payload",
    } }, {})).toBe(`${fallback}. Upstream message (untrusted): Invalid schema`);
  });

  it("removes sensitive argument values echoed without a field name", () => {
    expect(mcpErrorMessage(fallback, { message: "Rejected private-argument" }, {}, ["private-argument"]))
      .toBe(`${fallback}. Upstream message (untrusted): Rejected [REDACTED]`);
  });

  it.each([null, false, 42, "raw error", [], {}, { message: {} }, { message: [] }, { message: " \n " }])
    ("keeps the stable fallback for malformed error %j", error => {
      expect(mcpErrorMessage(fallback, error, {})).toBe(fallback);
    });
});
