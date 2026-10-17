import { describe, expect, it } from "vitest";
import {
  EMPTY_CLIENT_CREDENTIALS_FIELDS,
  canSubmitGenericConnect,
  clientCredentialsTokenUrlError,
  customHeaderError,
  defaultGenericMcpName,
  endpointHost,
  genericConnectGuidance,
  genericConnectPayload,
  newCustomHeaderRow,
  oauthCallbackUrlForBrowser,
  type GenericConnectDraft,
} from "./generic-mcp-connect";

function draft(overrides: Partial<GenericConnectDraft> = {}): GenericConnectDraft {
  return {
    link: "https://mcp.example.test/mcp",
    name: "Example",
    authMode: "auto",
    needsKey: false,
    keyValue: "",
    headers: [newCustomHeaderRow()],
    oauthClientId: "",
    oauthClientSecret: "",
    clientCredentials: EMPTY_CLIENT_CREDENTIALS_FIELDS,
    ...overrides,
  };
}

describe("endpointHost", () => {
  it("returns the host so the operator can see whose server this is", () => {
    expect(endpointHost("https://mcp.example.test/mcp?project_id=1")).toBe("mcp.example.test");
    expect(endpointHost("http://127.0.0.1:8848/mcp")).toBe("127.0.0.1:8848");
  });

  it("returns null for anything that isn't a URL", () => {
    expect(endpointHost("not a url")).toBeNull();
    expect(endpointHost("")).toBeNull();
  });
});

describe("oauthCallbackUrlForBrowser", () => {
  it("prefers the callback URL advertised by the server", () => {
    expect(oauthCallbackUrlForBrowser(
      "http://localhost:3000",
      "https://paperclip.example.test/api/tools/oauth/callback",
    )).toBe("https://paperclip.example.test/api/tools/oauth/callback");
  });

  it("uses localhost for local HTTP callbacks to match the API authorization request", () => {
    expect(oauthCallbackUrlForBrowser("http://127.0.0.1:3200")).toBe(
      "http://localhost:3200/api/tools/oauth/callback",
    );
    expect(oauthCallbackUrlForBrowser("http://[::1]:3200")).toBe(
      "http://localhost:3200/api/tools/oauth/callback",
    );
  });

  it("preserves public HTTPS origins", () => {
    expect(oauthCallbackUrlForBrowser("https://paperclip.example.test")).toBe(
      "https://paperclip.example.test/api/tools/oauth/callback",
    );
  });
});

describe("defaultGenericMcpName", () => {
  it("keeps the port and path so endpoints on one host get distinct names", () => {
    expect(defaultGenericMcpName("http://127.0.0.1:47399/mcp"))
      .toBe("127.0.0.1:47399/mcp");
    expect(defaultGenericMcpName("http://127.0.0.1:47400/analytics/mcp"))
      .toBe("127.0.0.1:47400/analytics/mcp");
  });

  it("does not copy a potentially secret query string into the name", () => {
    expect(defaultGenericMcpName("https://www.example.test/mcp?token=secret"))
      .toBe("example.test/mcp");
  });
});

describe("genericConnectGuidance", () => {
  it("names the URL as the thing to fix for invalid, unsafe and unreachable endpoints", () => {
    for (const code of [
      "mcp_remote_url_invalid",
      "remote_http_private_endpoint",
      "remote_http_dns_failed",
      "runtime_error",
    ]) {
      expect(genericConnectGuidance(code, null).focus, code).toBe("url");
    }
  });

  it("names the credentials for a challenge with no discoverable sign-in", () => {
    const guidance = genericConnectGuidance("oauth_challenge", null);
    expect(guidance.focus).toBe("credentials");
    expect(guidance.body).toContain("Advanced authentication");
  });

  it("points at the deployment when Paperclip itself has no public HTTPS address", () => {
    expect(genericConnectGuidance("oauth_redirect_origin_unsupported", null).focus).toBe("deployment");
  });

  it("does not ask the operator to resolve an internal name conflict", () => {
    const guidance = genericConnectGuidance("tool_access_name_conflict", null);
    expect(guidance).toMatchObject({ title: "Paperclip couldn’t name this connection", focus: "none" });
    expect(guidance.body).not.toContain("different name");
  });

  it("passes a rejected header's own message through", () => {
    const guidance = genericConnectGuidance(
      "mcp_header_rejected",
      'Paperclip manages the "Host" header and cannot send a custom value for it.',
    );
    expect(guidance.body).toContain('"Host"');
    expect(guidance.focus).toBe("credentials");
  });

  it("falls back to the server's message for an unrecognised code", () => {
    expect(genericConnectGuidance("something_new", "Upstream said no.").body).toBe("Upstream said no.");
    expect(genericConnectGuidance(null, null).body).toContain("Check it and try again");
  });
});

describe("customHeaderError", () => {
  it("accepts a filled row and ignores a blank one", () => {
    expect(customHeaderError([
      { id: "a", name: "X-Api-Key", value: "abc" },
      { id: "b", name: "", value: "" },
    ])).toBeNull();
  });

  it("rejects headers Paperclip refuses to send", () => {
    expect(customHeaderError([{ id: "a", name: "Host", value: "evil.example" }]))
      .toContain('Paperclip manages the "Host" header');
  });

  it("rejects a value that would split the request", () => {
    expect(customHeaderError([{ id: "a", name: "X-Api-Key", value: "abc\r\nX-Injected: 1" }]))
      .toContain("line breaks");
  });

  it("asks for a value on a half-filled row and flags duplicates", () => {
    expect(customHeaderError([{ id: "a", name: "X-Api-Key", value: "" }]))
      .toContain('Add a value for "X-Api-Key"');
    expect(customHeaderError([
      { id: "a", name: "X-Api-Key", value: "one" },
      { id: "b", name: "x-api-key", value: "two" },
    ])).toContain("listed twice");
  });
});

describe("genericConnectPayload", () => {
  it("sends nothing but the link on the simplest path", () => {
    expect(genericConnectPayload(draft())).toEqual({
      link: "https://mcp.example.test/mcp",
      name: "Example",
    });
  });

  it("omits authMode on the simple path so the server probes and decides", () => {
    const payload = genericConnectPayload(draft({ needsKey: true, keyValue: "abc" }));
    expect(payload.authMode).toBeUndefined();
    expect(payload.credentialValues).toEqual({ "credentials.authorization": "abc" });
  });

  it("sends the explicit mode chosen under Advanced authentication", () => {
    expect(genericConnectPayload(draft({ authMode: "none" }))).toMatchObject({ authMode: "none" });
    expect(genericConnectPayload(draft({ authMode: "bearer", keyValue: " abc " })))
      .toMatchObject({ authMode: "bearer", credentialValues: { "credentials.authorization": "abc" } });
  });

  it("maps custom headers to headers.* credential paths", () => {
    const payload = genericConnectPayload(draft({
      authMode: "custom_headers",
      headers: [
        { id: "a", name: " X-Api-Key ", value: "phx_secret" },
        { id: "b", name: "X-Project", value: "12345" },
        { id: "c", name: "", value: "" },
      ],
    }));
    expect(payload.credentialValues).toEqual({
      "headers.X-Api-Key": "phx_secret",
      "headers.X-Project": "12345",
    });
  });

  it("only sends a preregistered client when the operator supplied one", () => {
    expect(genericConnectPayload(draft({ authMode: "oauth" })).oauthClient).toBeUndefined();
    expect(genericConnectPayload(draft({ authMode: "oauth", oauthClientId: "cid" })).oauthClient)
      .toEqual({ clientId: "cid" });
    expect(genericConnectPayload(draft({
      authMode: "oauth",
      oauthClientId: "cid",
      oauthClientSecret: "shh",
    })).oauthClient).toEqual({ clientId: "cid", clientSecret: "shh" });
  });

  it("sends the token URL, scope and audience only for client credentials", () => {
    const clientCredentials = {
      tokenUrl: " https://auth.example.test/oauth/token ",
      scope: "tools.read",
      audience: "",
    };
    expect(genericConnectPayload(draft({
      authMode: "oauth_client_credentials",
      oauthClientId: "cid",
      oauthClientSecret: "shh",
      clientCredentials,
    }))).toEqual(expect.objectContaining({
      authMode: "oauth_client_credentials",
      oauthClient: {
        clientId: "cid",
        clientSecret: "shh",
        tokenUrl: "https://auth.example.test/oauth/token",
        scope: "tools.read",
      },
    }));
    expect(genericConnectPayload(draft({
      authMode: "oauth",
      oauthClientId: "cid",
      clientCredentials,
    })).oauthClient).toEqual({ clientId: "cid" });
  });

  it("does not carry a bearer key into a custom-header or no-auth submission", () => {
    // Switching modes must not leak a value the operator typed under a different
    // one — the wizard clears it, and the payload builder does not resurrect it.
    expect(genericConnectPayload(draft({ authMode: "custom_headers", keyValue: "stale" })).credentialValues)
      .toBeUndefined();
    expect(genericConnectPayload(draft({ authMode: "none", keyValue: "stale" })).credentialValues)
      .toBeUndefined();
  });
});

describe("client credentials guidance", () => {
  it("points a rejected token at scope and audience, not at a key", () => {
    expect(genericConnectGuidance("oauth_client_credentials_rejected", null)).toMatchObject({
      title: "The server rejected the token",
      focus: "none",
    });
  });
});

describe("canSubmitGenericConnect", () => {
  it("needs a link", () => {
    expect(canSubmitGenericConnect(draft({ link: "" }))).toBe(false);
  });

  it("lets the simple no-key path through and holds the yes-key path until a key is typed", () => {
    expect(canSubmitGenericConnect(draft())).toBe(true);
    expect(canSubmitGenericConnect(draft({ needsKey: true }))).toBe(false);
    expect(canSubmitGenericConnect(draft({ needsKey: true, keyValue: "abc" }))).toBe(true);
  });

  it("requires a key for the explicit bearer mode", () => {
    expect(canSubmitGenericConnect(draft({ authMode: "bearer" }))).toBe(false);
    expect(canSubmitGenericConnect(draft({ authMode: "bearer", keyValue: "abc" }))).toBe(true);
  });

  it("requires at least one valid header for custom-header mode", () => {
    expect(canSubmitGenericConnect(draft({ authMode: "custom_headers" }))).toBe(false);
    expect(canSubmitGenericConnect(draft({
      authMode: "custom_headers",
      headers: [{ id: "a", name: "X-Api-Key", value: "abc" }],
    }))).toBe(true);
    expect(canSubmitGenericConnect(draft({
      authMode: "custom_headers",
      headers: [{ id: "a", name: "Host", value: "abc" }],
    }))).toBe(false);
  });

  it("requires a client ID, secret and token URL for client credentials", () => {
    const complete = {
      authMode: "oauth_client_credentials" as const,
      oauthClientId: "cid",
      oauthClientSecret: "shh",
      clientCredentials: { ...EMPTY_CLIENT_CREDENTIALS_FIELDS, tokenUrl: "https://auth.example.test/oauth/token" },
    };
    expect(canSubmitGenericConnect(draft(complete))).toBe(true);
    expect(canSubmitGenericConnect(draft({ ...complete, oauthClientSecret: "" }))).toBe(false);
    expect(canSubmitGenericConnect(draft({ ...complete, clientCredentials: EMPTY_CLIENT_CREDENTIALS_FIELDS }))).toBe(false);
  });

  it("rejects a malformed token URL before submission and leaves the http policy to the server", () => {
    const withTokenUrl = (tokenUrl: string) => draft({
      authMode: "oauth_client_credentials",
      oauthClientId: "cid",
      oauthClientSecret: "shh",
      clientCredentials: { ...EMPTY_CLIENT_CREDENTIALS_FIELDS, tokenUrl },
    });
    for (const tokenUrl of [
      "auth.example.test/token",
      "ftp://auth.example.test/token",
      "https://user:pass@auth.example.test/token",
      "http://user:pass@10.0.0.5:3100/oauth/token",
      "http://10.0.0.5:3100/oauth/token#section",
    ]) {
      expect(clientCredentialsTokenUrlError(tokenUrl)).toBe("Enter a full token URL, such as https://auth.example.com/oauth/token.");
      expect(canSubmitGenericConnect(withTokenUrl(tokenUrl))).toBe(false);
    }
    for (const tokenUrl of ["https://auth.example.test/oauth/token", "http://10.0.0.5:3100/oauth/token"]) {
      expect(clientCredentialsTokenUrlError(tokenUrl)).toBeNull();
      expect(canSubmitGenericConnect(withTokenUrl(tokenUrl))).toBe(true);
    }
    expect(clientCredentialsTokenUrlError("")).toBeNull();
  });

  it("allows no-auth and browser sign-in without any value", () => {
    expect(canSubmitGenericConnect(draft({ authMode: "none" }))).toBe(true);
    expect(canSubmitGenericConnect(draft({ authMode: "oauth" }))).toBe(true);
  });
});
