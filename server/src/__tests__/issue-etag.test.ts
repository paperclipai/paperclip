import { describe, expect, it } from "vitest";
import {
  InvalidIssueEtagError,
  formatIssueEtag,
  parseOptionalIssueIfMatch,
} from "../http/issue-etag.js";

describe("issue ETags", () => {
  it("formats positive 32-bit issue versions", () => {
    expect(formatIssueEtag(1)).toBe("\"issue-v1\"");
    expect(formatIssueEtag(2_147_483_647)).toBe("\"issue-v2147483647\"");
  });

  it("parses an optional current issue ETag", () => {
    expect(parseOptionalIssueIfMatch(undefined)).toBeUndefined();
    expect(parseOptionalIssueIfMatch("\"issue-v42\"")).toBe(42);
    expect(parseOptionalIssueIfMatch("  \"issue-v42\"  ")).toBe(42);
  });

  it.each([
    "W/\"issue-v42\"",
    "*",
    "\"issue-v1\", \"issue-v2\"",
    "\"issue-v0\"",
    "\"issue-v-1\"",
    "\"issue-v2147483648\"",
    "\"other-v1\"",
    "",
  ])("rejects malformed If-Match value %j", (value) => {
    expect(() => parseOptionalIssueIfMatch(value)).toThrow(InvalidIssueEtagError);
  });

  it("rejects header arrays and invalid formatter input", () => {
    expect(() => parseOptionalIssueIfMatch(["\"issue-v1\""])).toThrow(
      InvalidIssueEtagError,
    );
    for (const version of [0, -1, 2_147_483_648, 1.5, Number.NaN]) {
      expect(() => formatIssueEtag(version)).toThrow(RangeError);
    }
  });
});
