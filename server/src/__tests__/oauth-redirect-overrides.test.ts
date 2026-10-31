import { describe, expect, it } from "vitest";
import {
  hasOAuthRedirectOverride,
  parseOAuthRedirectOverrides,
  resolveOAuthRedirectUri,
} from "../services/tool-access/oauth/redirect-overrides.js";

const fallback = "https://paperclip.example/api/tools/oauth/callback";
const local = "http://localhost:3100/api/tools/oauth/callback";

describe("oauth redirect overrides", () => {
  it("parses a valid mapping and normalizes the server to its origin", () => {
    const map = parseOAuthRedirectOverrides(
      JSON.stringify({ "https://mcp.norman.finance/mcp": local }),
    );
    expect([...map]).toEqual([["https://mcp.norman.finance", local]]);
  });

  it("ignores missing, invalid and non-object values", () => {
    expect(parseOAuthRedirectOverrides(undefined).size).toBe(0);
    expect(parseOAuthRedirectOverrides("  ").size).toBe(0);
    expect(parseOAuthRedirectOverrides("{oops").size).toBe(0);
    expect(parseOAuthRedirectOverrides("[1]").size).toBe(0);
  });

  it("drops only the invalid entries", () => {
    const map = parseOAuthRedirectOverrides(
      JSON.stringify({
        "https://good.example": local,
        "not a url": local,
        "https://bad-redirect.example": "ftp://x/y",
        "https://number.example": 5,
      }),
    );
    expect([...map.keys()]).toEqual(["https://good.example"]);
  });

  it("resolves the override by the connection's server origin, else the default", () => {
    const env = { PAPERCLIP_OAUTH_REDIRECT_OVERRIDES: JSON.stringify({ "https://mcp.norman.finance": local }) };
    expect(resolveOAuthRedirectUri("https://mcp.norman.finance/mcp", fallback, env)).toBe(local);
    expect(resolveOAuthRedirectUri("https://mcp.other.example/mcp", fallback, env)).toBe(fallback);
    expect(resolveOAuthRedirectUri(undefined, fallback, env)).toBe(fallback);
    expect(resolveOAuthRedirectUri("https://mcp.norman.finance/mcp", fallback, {})).toBe(fallback);
  });

  it("reports whether a connection's server has an override", () => {
    const env = { PAPERCLIP_OAUTH_REDIRECT_OVERRIDES: JSON.stringify({ "https://mcp.norman.finance": local }) };
    expect(hasOAuthRedirectOverride("https://mcp.norman.finance/mcp", env)).toBe(true);
    expect(hasOAuthRedirectOverride("https://mcp.other.example/mcp", env)).toBe(false);
    expect(hasOAuthRedirectOverride(undefined, env)).toBe(false);
    expect(hasOAuthRedirectOverride("https://mcp.norman.finance/mcp", {})).toBe(false);
  });
});
