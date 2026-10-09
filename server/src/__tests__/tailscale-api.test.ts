import { describe, expect, it, vi } from "vitest";
import { TailscaleApiError, isTailscaleConnection, tailscaleApi, tailscaleHealthMessage } from "../services/tailscale-api.js";

const CLIENT_ID = "kFIXTURECNTRL";
const CLIENT_SECRET = "tskey-client-fixture-secret-value";
const TOKEN = "tskey-api-fixture-access-token";
const TEST_KEY_SECRET = "tskey-auth-fixture-minted-key";
const PROVIDER_BODY = "private tailnet detail: fixture.example.ts.net tag:secret-tag";

type Behavior = {
  tokenStatus?: number;
  scope?: string;
  devicesStatus?: number;
  createStatus?: number;
  deleteStatus?: number;
  keyTags?: string[];
  keyBody?: unknown;
  unreachable?: boolean;
  /** Return HTTP 200 for the device list with a body stream that fails mid-read. */
  devicesStreamFails?: boolean;
};

function failingStreamResponse() {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode('{"devices":['));
      controller.error(new TypeError(`terminated: ${PROVIDER_BODY}`));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

function fakeTailscale(behavior: Behavior = {}) {
  const calls: { method: string; path: string; headers: Headers; body: string | undefined }[] = [];
  const request = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/api/v2", "") + parsed.search;
    calls.push({ method: init.method ?? "GET", path, headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : undefined });
    if (behavior.unreachable) throw new Error(`connect ECONNREFUSED ${url} ${PROVIDER_BODY}`);
    if (path === "/oauth/token") {
      if (behavior.tokenStatus) return Response.json({ message: PROVIDER_BODY }, { status: behavior.tokenStatus });
      return Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 3600, scope: behavior.scope ?? "auth_keys devices:core" });
    }
    if (new Headers(init.headers).get("Authorization") !== `Bearer ${TOKEN}`) return Response.json({ message: PROVIDER_BODY }, { status: 401 });
    if (path === "/tailnet/-/devices?fields=all" || path === "/tailnet/example.com/devices?fields=all") {
      if (behavior.devicesStatus) return Response.json({ message: PROVIDER_BODY }, { status: behavior.devicesStatus });
      if (behavior.devicesStreamFails) return failingStreamResponse();
      return Response.json({ devices: [{ nodeId: "nFIXTURE1", name: "devbox.fixture.example.ts.net", addresses: ["100.64.0.7"], tags: ["tag:dev-box"], os: "linux" }, { nodeId: "nFIXTURE2", name: "laptop.fixture.example.ts.net", addresses: ["100.64.0.8"] }] });
    }
    if ((path === "/tailnet/-/keys" || path === "/tailnet/example.com/keys") && init.method === "POST") {
      if (behavior.createStatus) return Response.json({ message: PROVIDER_BODY }, { status: behavior.createStatus });
      if (behavior.keyBody !== undefined) return Response.json(behavior.keyBody);
      const requested = JSON.parse(String(init.body)) as { capabilities: { devices: { create: { tags: string[] } } } };
      return Response.json({
        id: "kTESTKEY1",
        key: TEST_KEY_SECRET,
        created: "2026-10-09T10:00:00Z",
        expires: "2026-10-09T10:05:00Z",
        capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: behavior.keyTags ?? requested.capabilities.devices.create.tags } } },
        description: "Paperclip connection check (deleted immediately)",
      });
    }
    if (path.startsWith("/tailnet/") && path.includes("/keys/") && init.method === "DELETE") {
      if (behavior.deleteStatus) return Response.json({ message: PROVIDER_BODY }, { status: behavior.deleteStatus });
      return new Response(null, { status: 200 });
    }
    if (path.startsWith("/device/") && init.method === "DELETE") return new Response(null, { status: 200 });
    throw new Error(`Unexpected fixture path ${init.method} ${path}`);
  });
  return { request, calls };
}

const api = (behavior: Behavior = {}, tailnet?: string) => {
  const fake = fakeTailscale(behavior);
  return { ...fake, client: tailscaleApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tailnet, request: fake.request }) };
};

async function failure(promise: Promise<unknown>): Promise<TailscaleApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TailscaleApiError);
    return error as TailscaleApiError;
  }
  throw new Error("expected the Tailscale call to fail");
}

describe("Tailscale API boundary", () => {
  it("recognizes only the catalog's REST connection", () => {
    expect(isTailscaleConnection({ transport: "rest_api", config: { sourceTemplateKey: "tailscale" } })).toBe(true);
    expect(isTailscaleConnection({ transport: "mcp_remote", config: { sourceTemplateKey: "tailscale" } })).toBe(false);
    expect(isTailscaleConnection({ transport: "rest_api", config: { sourceTemplateKey: "browser-use-cloud" } })).toBe(false);
  });

  it("exchanges the OAuth client once, lists devices, and mints then deletes an ephemeral tagged test key", async () => {
    const { client, calls } = api();
    const health = await client.verify({ agentTag: "tag:paperclip-agent" });
    expect(health).toMatchObject({ tailnet: "-", scopes: ["auth_keys", "devices:core"], tags: ["tag:paperclip-agent"], deviceCount: 2 });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /oauth/token",
      "GET /tailnet/-/devices?fields=all",
      "POST /tailnet/-/keys",
      "DELETE /tailnet/-/keys/kTESTKEY1",
    ]);
    const token = calls[0]!;
    expect(token.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(token.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(token.body).get("client_id")).toBe(CLIENT_ID);
    expect(new URLSearchParams(token.body).get("client_secret")).toBe(CLIENT_SECRET);
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:paperclip-agent"] } } },
      expirySeconds: 300,
      description: "Paperclip connection check (deleted immediately)",
    });
    const message = tailscaleHealthMessage(health);
    expect(message).toContain("Scopes: auth_keys, devices:core");
    expect(message).toContain("Tags: tag:paperclip-agent");
    for (const text of [JSON.stringify(health), message]) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TEST_KEY_SECRET);
    }
  });

  it("addresses a named tailnet and reuses the cached token across calls", async () => {
    const { client, calls } = api({}, "example.com");
    await client.listDevices();
    await client.deleteDevice("nFIXTURE1");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /oauth/token",
      "GET /tailnet/example.com/devices?fields=all",
      "DELETE /device/nFIXTURE1",
    ]);
  });

  it.each([400, 401, 403])("maps a rejected client credential exchange (%s) to an actionable code", async (status) => {
    const error = await failure(api({ tokenStatus: status }).client.verify());
    expect(error).toMatchObject({ status: 422, code: "tailscale_client_invalid", operation: "token", providerStatus: status });
    expect(error.message).not.toContain(PROVIDER_BODY);
  });

  it("reports a missing devices:core scope from the token scopes before touching the tailnet", async () => {
    const { client, calls } = api({ scope: "auth_keys" });
    const error = await failure(client.verify());
    expect(error).toMatchObject({ status: 422, code: "tailscale_scope_devices_missing" });
    expect(calls).toHaveLength(1);
  });

  it("reports a missing auth_keys scope from the token scopes before minting anything", async () => {
    const { client, calls } = api({ scope: "devices:core:read" });
    const error = await failure(client.verify());
    expect(error).toMatchObject({ status: 422, code: "tailscale_scope_auth_keys_missing" });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/keys"))).toHaveLength(0);
  });

  it("falls back to provider responses when the token endpoint omits scopes", async () => {
    const devices = await failure(api({ scope: "", devicesStatus: 403 }).client.verify());
    expect(devices).toMatchObject({ code: "tailscale_scope_devices_missing", operation: "list_devices", providerStatus: 403 });
    const tailnet = await failure(api({ scope: "", devicesStatus: 404 }, "example.com").client.verify());
    expect(tailnet).toMatchObject({ code: "tailscale_tailnet_not_found" });
    expect(tailnet.message).toContain("example.com");
    expect(tailnet.message).not.toContain(PROVIDER_BODY);
  });

  it("distinguishes a tag the client cannot assign from a missing auth_keys scope", async () => {
    const tag = await failure(api({ createStatus: 403 }).client.verify({ agentTag: "tag:paperclip-agent" }));
    expect(tag).toMatchObject({ status: 422, code: "tailscale_tag_not_owned", operation: "create_key" });
    expect(tag.message).toContain("tag:paperclip-agent");
    expect(tag.message).not.toContain(PROVIDER_BODY);
    const scope = await failure(api({ scope: "all:read", createStatus: 403 }).client.verify());
    expect(scope).toMatchObject({ code: "tailscale_scope_auth_keys_missing" });
  });

  it("deletes the test key even when validating it fails afterwards", async () => {
    const { client, calls } = api({ keyTags: ["tag:other"] });
    const error = await failure(client.verify({ agentTag: "tag:paperclip-agent" }));
    expect(error).toMatchObject({ code: "tailscale_tag_not_owned" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("DELETE /tailnet/-/keys/kTESTKEY1");
  });

  it("reports a test key that could not be deleted without hiding the key id", async () => {
    const error = await failure(api({ deleteStatus: 500 }).client.verify());
    expect(error).toMatchObject({ status: 502, code: "tailscale_test_key_cleanup_failed", operation: "delete_key", providerStatus: 500 });
    expect(error.message).toContain("5 minutes");
    expect(error.message).not.toContain(TEST_KEY_SECRET);
  });

  it("reports a cleanup failure first and keeps the superseded validation failure as secondary information", async () => {
    const error = await failure(api({ keyTags: ["tag:other"], deleteStatus: 500 }).client.verify({ agentTag: "tag:paperclip-agent" }));
    expect(error).toMatchObject({
      status: 502,
      code: "tailscale_test_key_cleanup_failed",
      operation: "delete_key",
      providerStatus: 500,
      secondary: { code: "tailscale_tag_not_owned", operation: "create_key" },
    });
    expect(error.details).toMatchObject({ code: "tailscale_test_key_cleanup_failed", secondary: { code: "tailscale_tag_not_owned" } });
    expect(error.message).toContain("could not delete it");
    expect(error.message).toContain("Also: Tailscale issued the test key without tag:paperclip-agent");
    expect(error.message).not.toContain(PROVIDER_BODY);
    expect(error.message).not.toContain(TEST_KEY_SECRET);
  });

  it("deletes a key whose create response carries a usable id but fails validation", async () => {
    const { client, calls } = api({ keyBody: { id: "kTESTKEY1", key: TEST_KEY_SECRET, capabilities: "bogus" } });
    const error = await failure(client.verify());
    expect(error).toMatchObject({ status: 502, code: "tailscale_request_failed", operation: "create_key", secondary: null });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /oauth/token",
      "GET /tailnet/-/devices?fields=all",
      "POST /tailnet/-/keys",
      "DELETE /tailnet/-/keys/kTESTKEY1",
    ]);
  });

  it("reports the cleanup failure when a malformed key response cannot be deleted either", async () => {
    const { client, calls } = api({ keyBody: { id: "kTESTKEY1", capabilities: "bogus" }, deleteStatus: 500 });
    const error = await failure(client.verify());
    expect(error).toMatchObject({
      code: "tailscale_test_key_cleanup_failed",
      secondary: { code: "tailscale_request_failed", operation: "create_key" },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("DELETE /tailnet/-/keys/kTESTKEY1");
  });

  it("skips deletion only when the malformed key response has no usable id", async () => {
    const { client, calls } = api({ keyBody: { nope: true } });
    await failure(client.verify());
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("normalizes a response stream that fails mid-body into a fixed error", async () => {
    const { client, calls } = api({ devicesStreamFails: true });
    const error = await failure(client.verify());
    expect(error).toMatchObject({ status: 502, code: "tailscale_request_failed", operation: "list_devices", providerStatus: null });
    expect(error.message).toBe("Tailscale ended the response early during list devices. Try again in a minute.");
    expect(error.message).not.toContain(PROVIDER_BODY);
    // Nothing was minted, so there is nothing to clean up.
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/keys"))).toHaveLength(0);
  });

  it("maps rate limits, unreachable hosts, and malformed bodies without echoing provider content", async () => {
    const limited = await failure(api({ tokenStatus: 429 }).client.verify());
    expect(limited).toMatchObject({ status: 502, code: "tailscale_rate_limited" });
    const down = await failure(api({ unreachable: true }).client.verify());
    expect(down).toMatchObject({ status: 502, code: "tailscale_unreachable", operation: "token" });
    expect(down.message).not.toContain(PROVIDER_BODY);
    const malformed = await failure(api({ keyBody: { nope: true } }).client.verify());
    expect(malformed).toMatchObject({ status: 502, code: "tailscale_request_failed", operation: "create_key" });
    const other = await failure(api({ devicesStatus: 503 }).client.verify());
    expect(other).toMatchObject({ status: 502, code: "tailscale_request_failed", providerStatus: 503 });
    expect(other.message).toBe("Tailscale returned HTTP 503 during list devices.");
  });

  it("never puts the client secret, token, or provider body into an error", async () => {
    for (const behavior of [
      { tokenStatus: 401 },
      { devicesStatus: 403 },
      { createStatus: 400 },
      { deleteStatus: 403 },
      { unreachable: true },
      { devicesStreamFails: true },
      { keyTags: ["tag:other"], deleteStatus: 500 },
      { keyBody: { id: "kTESTKEY1", key: TEST_KEY_SECRET, capabilities: "bogus" }, deleteStatus: 500 },
    ] satisfies Behavior[]) {
      const error = await failure(api(behavior).client.verify());
      const serialized = `${error.message} ${JSON.stringify(error.details)} ${error.stack ?? ""}`;
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(TEST_KEY_SECRET);
      expect(serialized).not.toContain(PROVIDER_BODY);
    }
  });
});
