import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { developmentSlackManager } from "../services/connectors/slack/setup/development-manager.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slack-development-")); roots.push(root);
  const path = join(root, "manager.json");
  writeFileSync(path, JSON.stringify({ appId: "A123", clientId: "123.456", clientSecret: "client-secret-canary" }), { mode: 0o600 });
  return { path, env: { NODE_ENV: "development", PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED: "true", PAPERCLIP_SLACK_MANAGER_DEVELOPMENT_CONFIG: path } };
}
const origin = () => "https://local-test.trycloudflare.com";
const identity = { subject: "actor", companyId: "company", profile: "slack.manager" as const };
const user = { id: "U123", token_type: "user", access_token: "access-canary", refresh_token: "refresh-canary", expires_in: 43200, scope: SLACK_MANAGER_SCOPES.join(",") };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("local managed Slack qualification", () => {
  it("requires explicit development opt-in and refuses production", () => {
    const { env } = fixture();
    expect(developmentSlackManager(origin, {})).toBeNull();
    expect(developmentSlackManager(origin, { ...env, NODE_ENV: "production" })).toBeNull();
    expect(developmentSlackManager(origin, { ...env, PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED: "false" })).toBeNull();
  });
  it("rejects readable secrets and invalid HTTPS origins", async () => {
    const { env, path } = fixture(); chmodSync(path, 0o644);
    expect(() => developmentSlackManager(origin, env)).toThrow();
    chmodSync(path, 0o600);
    await expect(developmentSlackManager(() => "http://local.test", env)!.getSlackManagerAppId()).rejects.toThrow();
  });
  it("builds a scoped authorization URL without exposing the client secret", async () => {
    const { env } = fixture();
    const client = developmentSlackManager(origin, env)!;
    const result = await client.startAuthorization({ ...identity, returnUri: `${origin()}/api/chat-slack/managed/oauth/callback`, returnState: "bound-state" });
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe("https://slack.com");
    expect(url.searchParams.get("state")).toBe("bound-state");
    expect(url.searchParams.get("user_scope")).toBe(SLACK_MANAGER_SCOPES.join(","));
    expect(JSON.stringify(result)).not.toContain("client-secret-canary");
    await expect(client.startAuthorization({ ...identity, returnUri: "https://other.test/callback", returnState: "bound-state" })).rejects.toThrow();
  });
  it("exchanges the code against the exact callback and preserves actor/workspace identity", async () => {
    const { env } = fixture();
    const fetcher = vi.fn().mockResolvedValue(response({ ok: true, app_id: "A123", team: { id: "T123", name: "Paperclip" }, authed_user: user }));
    const result = await developmentSlackManager(origin, env, fetcher)!.claim({ ...identity, claimId: "code-canary", redemptionId: "once" });
    expect(result.slackManager).toEqual({ appId: "A123", workspaceId: "T123", workspaceName: "Paperclip", userId: "U123" });
    expect(result.subject).toBe("actor"); expect(result.companyId).toBe("company");
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    expect(request.redirect).toBe("error");
    expect(request.body.get("redirect_uri")).toBe(`${origin()}/api/chat-slack/managed/oauth/callback`);
    expect(request.body.get("code")).toBe("code-canary");
  });
  it.each(["wrong-app", "missing-scope", "provider-echo"])("rejects %s without echoing secrets", async reason => {
    const { env } = fixture();
    const value = reason === "provider-echo" ? { ok: false, error: "client-secret-canary code-canary" } : { ok: true, app_id: reason === "wrong-app" ? "AOTHER" : "A123", team: { id: "T123", name: "Paperclip" }, authed_user: { ...user, scope: reason === "missing-scope" ? "" : user.scope } };
    const client = developmentSlackManager(origin, env, vi.fn().mockResolvedValue(response(value)))!;
    const error = await client.claim({ ...identity, claimId: "code-canary", redemptionId: "once" }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/canary/);
  });
  it("rotates refresh credentials and verifies revocation", async () => {
    const { env } = fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ok: true, ...user })).mockResolvedValueOnce(response({ ok: false, error: "invalid_auth" }));
    const client = developmentSlackManager(origin, env, fetcher)!;
    expect((await client.refresh({ ...identity, refreshToken: "old-refresh" })).refreshToken).toBe("refresh-canary");
    expect(fetcher.mock.calls[0][1].body.get("grant_type")).toBe("refresh_token");
    await expect(client.revoke({ ...identity, token: "access-canary" })).rejects.toThrow();
  });
});
