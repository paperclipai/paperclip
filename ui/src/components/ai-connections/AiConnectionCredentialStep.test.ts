import { describe, expect, it } from "vitest";
import { parseGatewayHeaders } from "./AiConnectionCredentialStep";

describe("parseGatewayHeaders", () => {
  it("reads one Name: value per line and keeps colons in values", () => {
    expect(parseGatewayHeaders("x-team: platform\n\n  x-trace: a:b  ")).toEqual({ "x-team": "platform", "x-trace": "a:b" });
    expect(parseGatewayHeaders("")).toEqual({});
  });
  it("reports the first line without a name", () => {
    expect(parseGatewayHeaders("x-team platform")).toContain("x-team platform");
    expect(parseGatewayHeaders(": value")).toContain(": value");
  });
});
