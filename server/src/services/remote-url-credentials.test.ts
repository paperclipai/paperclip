import { describe, expect, it } from "vitest";
import {
  redactRemoteUrlCredential,
  remoteUrlCredentialMatchesPublicUrl,
  splitRemoteUrlCredential,
} from "./remote-url-credentials.js";

describe("remote URL credentials", () => {
  it("moves token query values out of the stored connection URL", () => {
    expect(splitRemoteUrlCredential(
      "https://mcp.zapier.com/api/v1/connect?token=zapier-secret&region=us",
    )).toEqual({
      publicUrl: "https://mcp.zapier.com/api/v1/connect?region=us",
      secretUrl: "https://mcp.zapier.com/api/v1/connect?token=zapier-secret&region=us",
      secretParameterNames: ["token"],
    });
  });

  it("leaves non-sensitive URLs inline", () => {
    expect(splitRemoteUrlCredential("https://example.test/mcp?region=us")).toEqual({
      publicUrl: "https://example.test/mcp?region=us",
      secretUrl: null,
      secretParameterNames: [],
    });
  });

  it("moves URL userinfo out of the stored connection URL", () => {
    expect(splitRemoteUrlCredential(
      "https://api-key:secret@example.test/mcp?region=us",
    )).toEqual({
      publicUrl: "https://example.test/mcp?region=us",
      secretUrl: "https://api-key:secret@example.test/mcp?region=us",
      secretParameterNames: [],
    });
    expect(remoteUrlCredentialMatchesPublicUrl(
      "https://example.test/mcp?region=us",
      "https://api-key:secret@example.test/mcp?region=us",
    )).toBe(true);
  });

  it("redacts credentials in activity-log URLs", () => {
    expect(redactRemoteUrlCredential(
      "https://user:password@example.test/mcp?token=secret&region=us",
    )).toBe("https://REDACTED@example.test/mcp?token=REDACTED&region=us");
  });

  it("allows only secret-query differences when materializing a vault URL", () => {
    expect(remoteUrlCredentialMatchesPublicUrl(
      "https://example.test/mcp?region=us",
      "https://example.test/mcp?region=us&token=secret",
    )).toBe(true);
    expect(remoteUrlCredentialMatchesPublicUrl(
      "https://example.test/mcp?region=us",
      "https://other.test/mcp?region=us&token=secret",
    )).toBe(false);
  });
});
