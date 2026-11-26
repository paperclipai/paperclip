import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { startOAuthRefreshFixture } from "./oauth-refresh-fixture.mjs";

async function connect(fixture, { offline = true, consent = true, grantTypes = ["authorization_code", "refresh_token"] } = {}) {
  const redirectUri = "http://127.0.0.1:3100/api/tools/oauth/callback";
  const registration = await fetch(`${fixture.issuer}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], grant_types: grantTypes }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = "fixture-proof-key-for-tests";
  const authorization = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", state: "fixture-state",
    resource: fixture.mcpUrl, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: offline ? "mcp:read offline_access" : "mcp:read", decision: "allow",
    ...(consent ? { prompt: "consent" } : {}),
  });
  const response = await fetch(`${fixture.issuer}/authorize`, { method: "POST", body: authorization, redirect: "manual" });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location"));
  const exchangeBody = new URLSearchParams({
    grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri,
    resource: fixture.mcpUrl, code_verifier: verifier, code: callback.searchParams.get("code"),
  });
  const exchange = await fetch(`${fixture.issuer}/token`, { method: "POST", body: exchangeBody });
  assert.equal(exchange.status, 200);
  return { tokens: await exchange.json(), clientId: client.client_id };
}

async function call(fixture, accessToken) {
  return fetch(fixture.mcpUrl, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_status", arguments: {} } }),
  });
}

for (const options of [{ offline: false }, { consent: false }]) {
  test(`access-only grant disconnects after expiry: ${JSON.stringify(options)}`, async () => {
    const fixture = await startOAuthRefreshFixture();
    try {
      const { tokens } = await connect(fixture, options);
      assert.equal(tokens.refresh_token, undefined);
      assert.equal((await call(fixture, tokens.access_token)).status, 200);
      fixture.advanceTime(3_601_000);
      assert.equal((await call(fixture, tokens.access_token)).status, 401);
    } finally { await fixture.close(); }
  });
}

test("authorization-code-only provider rejects refresh registration and token requests", async () => {
  const fixture = await startOAuthRefreshFixture({ grantTypes: ["authorization_code"] });
  try {
    const registration = await fetch(`${fixture.issuer}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:3100/api/tools/oauth/callback"], grant_types: ["authorization_code", "refresh_token"] }),
    });
    assert.equal(registration.status, 400);
    assert.deepEqual(await registration.json(), { error: "invalid_client_metadata" });
    const { tokens, clientId } = await connect(fixture, { grantTypes: ["authorization_code"] });
    assert.equal(tokens.refresh_token, undefined);
    assert.equal((await call(fixture, tokens.access_token)).status, 200);
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, resource: fixture.mcpUrl, refresh_token: "unissued-token" });
    const refresh = await fetch(`${fixture.issuer}/token`, { method: "POST", body });
    assert.equal(refresh.status, 400);
    assert.deepEqual(await refresh.json(), { error: "unsupported_grant_type" });
    fixture.advanceTime(3_601_000);
    assert.equal((await call(fixture, tokens.access_token)).status, 401);
  } finally { await fixture.close(); }
});

test("offline consent permits refresh, requires the same resource, and rejects refresh-token reuse", async () => {
  const fixture = await startOAuthRefreshFixture();
  try {
    const { tokens, clientId } = await connect(fixture);
    assert.ok(tokens.refresh_token);
    fixture.advanceTime(3_601_000);
    assert.equal((await call(fixture, tokens.access_token)).status, 401);
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, resource: `${fixture.origin}/other`, refresh_token: tokens.refresh_token });
    assert.equal((await fetch(`${fixture.issuer}/token`, { method: "POST", body })).status, 400);
    body.set("resource", fixture.mcpUrl);
    const refresh = await fetch(`${fixture.issuer}/token`, { method: "POST", body });
    assert.equal(refresh.status, 200);
    const rotated = await refresh.json();
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.equal((await call(fixture, rotated.access_token)).status, 200);
    assert.equal((await fetch(`${fixture.issuer}/token`, { method: "POST", body })).status, 400);
  } finally { await fixture.close(); }
});
