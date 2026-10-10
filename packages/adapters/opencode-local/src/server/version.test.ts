import { describe, expect, it } from "vitest";
import {
  allowsUnsupportedOpenCodeVersion,
  parseOpenCodeCliVersion,
  supportedOpenCodeMajors,
  unsupportedOpenCodeVersionMessage,
  usesOpenCodeV2Cli,
} from "./version.js";

describe("parseOpenCodeCliVersion", () => {
  it("parses a bare semantic version", () => {
    expect(parseOpenCodeCliVersion("1.18.34")).toMatchObject({
      version: "1.18.34",
      major: 1,
      minor: 18,
      patch: 34,
      supported: true,
    });
  });

  it("extracts the version from prefixed CLI output", () => {
    expect(parseOpenCodeCliVersion("opencode v2.0.26\n")).toMatchObject({
      version: "2.0.26",
      supported: true,
    });
  });

  it("qualifies the V1 and V2 lines and flags an unknown future major", () => {
    expect(parseOpenCodeCliVersion("1.18.34")?.supported).toBe(true);
    expect(parseOpenCodeCliVersion("2.0.26")).toMatchObject({
      major: 2,
      supported: true,
    });
    expect(parseOpenCodeCliVersion("3.0.0")).toMatchObject({
      major: 3,
      supported: false,
    });
  });

  it("returns null when no version is present", () => {
    expect(parseOpenCodeCliVersion("")).toBeNull();
    expect(parseOpenCodeCliVersion("command not found")).toBeNull();
    expect(parseOpenCodeCliVersion(null)).toBeNull();
    expect(parseOpenCodeCliVersion(undefined)).toBeNull();
  });
});

describe("usesOpenCodeV2Cli", () => {
  it("is true only for the V2 major", () => {
    expect(usesOpenCodeV2Cli(parseOpenCodeCliVersion("1.18.34"))).toBe(false);
    expect(usesOpenCodeV2Cli(parseOpenCodeCliVersion("2.0.26"))).toBe(true);
    expect(usesOpenCodeV2Cli(null)).toBe(false);
    expect(usesOpenCodeV2Cli(undefined)).toBe(false);
  });
});

describe("supportedOpenCodeMajors", () => {
  it("lists the qualified lines", () => {
    expect(supportedOpenCodeMajors()).toBe("1.x and 2.x");
  });
});

describe("unsupportedOpenCodeVersionMessage", () => {
  it("names the supported lines and the remediation", () => {
    const message = unsupportedOpenCodeVersionMessage("3.0.0");
    expect(message).toContain("OpenCode 3.0.0 is not supported");
    expect(message).toContain("OpenCode 1.x and 2.x");
    expect(message).toContain("1.18.34");
    expect(message).toContain("--version 1.18.34");
    expect(message).toContain("PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION=1");
  });
});

describe("allowsUnsupportedOpenCodeVersion", () => {
  it("honours only truthy flag values", () => {
    expect(
      allowsUnsupportedOpenCodeVersion({
        PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "1",
      }),
    ).toBe(true);
    expect(
      allowsUnsupportedOpenCodeVersion({
        PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "true",
      }),
    ).toBe(true);
    expect(
      allowsUnsupportedOpenCodeVersion({
        PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "0",
      }),
    ).toBe(false);
    expect(allowsUnsupportedOpenCodeVersion({})).toBe(false);
  });
});
