import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { RegisteredProvider } from "../types.js";
import { revokeUpstreamToken } from "../revoke.js";

interface RevokeFixture {
  close: () => void;
  base: string;
  readonly lastUrl: string;
  readonly lastBody: string;
  readonly lastAuth: string;
  readonly lastMethod: string;
  readonly lastContentType: string;
  readonly hits: number;
  setStatus: (status: number) => void;
}

function makeProvider(
  revokeEndpoint: string | undefined,
  clientId = "the-client",
  clientSecret = "the-secret",
  revokeMethod?: "post-form" | "delete-json",
): RegisteredProvider {
  return {
    config: {
      id: "p",
      displayName: "P",
      clientCredentials: { clientIdEnv: "X", clientSecretEnv: "Y" },
      endpoints: {
        authorize: "https://x/a",
        token: "https://x/t",
        accountInfo: "https://x/me",
        ...(revokeEndpoint ? { revoke: revokeEndpoint } : {}),
      },
      scopes: { default: [], offered: [] },
      pkce: "required",
      authMethod: "post",
      responseFormat: "json",
      accountIdField: "id",
      accountLabelField: "login",
      ...(revokeMethod ? { revokeMethod } : {}),
      refresh: { supported: false },
    },
    clientId,
    clientSecret,
    shape: {},
    source: "yaml",
  } as unknown as RegisteredProvider;
}

describe("revokeUpstreamToken", () => {
  let fixture: RevokeFixture;
  let raw: Server;

  beforeEach(async () => {
    const http = await import("node:http");
    let lastUrl = "";
    let lastBody = "";
    let lastAuth = "";
    let lastMethod = "";
    let lastContentType = "";
    let hits = 0;
    let status = 200;
    const s = http.createServer((req, res) => {
      hits++;
      lastUrl = String(req.url ?? "");
      lastMethod = String(req.method ?? "");
      lastAuth = String(req.headers.authorization ?? "");
      lastContentType = String(req.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = status;
        res.end(status === 200 ? "" : "nope");
      });
    });
    raw = s;
    await new Promise<void>((r) => s.listen(0, r));
    const port = (s.address() as { port: number }).port;
    fixture = {
      close: () => s.close(),
      base: `http://127.0.0.1:${port}`,
      get lastUrl() { return lastUrl; },
      get lastBody() { return lastBody; },
      get lastAuth() { return lastAuth; },
      get lastMethod() { return lastMethod; },
      get lastContentType() { return lastContentType; },
      get hits() { return hits; },
      setStatus: (s) => { status = s; },
    };
  });

  afterEach(() => fixture.close());

  it("is a no-op when endpoints.revoke is absent", async () => {
    const provider = makeProvider(undefined);
    await revokeUpstreamToken({
      provider,
      accessToken: "AT",
      refreshToken: "RT",
    });
    expect(fixture.hits).toBe(0);
  });

  it("substitutes {client_id} placeholder in the URL", async () => {
    const provider = makeProvider(
      `${fixture.base}/applications/{client_id}/grant`,
      "abc-client",
    );
    await revokeUpstreamToken({ provider, accessToken: "AT" });
    expect(fixture.lastUrl).toBe("/applications/abc-client/grant");
  });

  it("sends token_type_hint=refresh_token when refresh token is provided", async () => {
    const provider = makeProvider(`${fixture.base}/revoke`);
    await revokeUpstreamToken({
      provider,
      accessToken: "AT",
      refreshToken: "RT",
    });
    expect(fixture.lastBody).toContain("token=RT");
    expect(fixture.lastBody).toContain("token_type_hint=refresh_token");
    expect(fixture.lastBody).not.toContain("token=AT");
    expect(fixture.lastMethod).toBe("POST");
    const expected = `Basic ${Buffer.from("the-client:the-secret").toString("base64")}`;
    expect(fixture.lastAuth).toBe(expected);
  });

  it("sends token_type_hint=access_token when only access token is provided", async () => {
    const provider = makeProvider(`${fixture.base}/revoke`);
    await revokeUpstreamToken({ provider, accessToken: "AT" });
    expect(fixture.lastBody).toContain("token=AT");
    expect(fixture.lastBody).toContain("token_type_hint=access_token");
  });

  it("supports GitHub-style DELETE JSON revocation", async () => {
    const provider = makeProvider(
      `${fixture.base}/applications/{client_id}/grant`,
      "abc-client",
      "the-secret",
      "delete-json",
    );
    await revokeUpstreamToken({ provider, accessToken: "AT" });
    expect(fixture.lastMethod).toBe("DELETE");
    expect(fixture.lastContentType).toContain("application/json");
    expect(JSON.parse(fixture.lastBody)).toEqual({ access_token: "AT" });
    expect(fixture.lastUrl).toBe("/applications/abc-client/grant");
  });

  it("throws on a non-2xx upstream response", async () => {
    const provider = makeProvider(`${fixture.base}/revoke`);
    fixture.setStatus(401);
    await expect(
      revokeUpstreamToken({ provider, accessToken: "AT" }),
    ).rejects.toThrow(/upstream revoke failed: 401/);
  });
});
