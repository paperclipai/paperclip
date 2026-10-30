import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { createChatCredentials } from "../credentials.js";
import type { EndpointRow } from "../runtime-types.js";
import { createSlackWebhookCallbacks } from "./webhook-callbacks.js";

function fixture() {
  const refs: ToolCredentialSecretRef[] = ["botToken", "signingSecret", "appToken"].map(key => ({
    secretId: randomUUID(), configPath: `credentials.${key}`, versionSelector: "latest", required: true,
  }));
  const endpoint = { id: randomUUID(), companyId: randomUUID(), connectionId: randomUUID(),
    provider: "slack", providerAccountId: "T-EXPECTED" } as EndpointRow;
  let signingSecret = "current-signing-secret";
  const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string, ..._resolution: unknown[]) => {
    const ref = refs.find(ref => ref.secretId === secretId)!;
    if (ref.configPath === "credentials.signingSecret") return signingSecret;
    throw new Error("Unrelated provider credential is unavailable");
  });
  const rows: Array<{ refs: ToolCredentialSecretRef[]; config: Record<string, unknown> }> = [{ refs, config: {} }];
  const db = { select: vi.fn(() => ({ from: () => ({ where: () => Promise.resolve(rows) }) })) } as unknown as Db;
  const credentials = createChatCredentials(db, { secrets: { resolveSecretValue } } as unknown as Parameters<typeof createChatCredentials>[1]);
  const callbacks = createSlackWebhookCallbacks(db, {
    resolveCredentials: credentials.resolveCredentials,
    runtimeCallbackEndpoint: vi.fn(async () => endpoint),
    getWebhookPublicBaseUrl: () => null,
    scheduleMessageProcessing: vi.fn(),
    slackRegistration: { notifyVerified: vi.fn(async () => {}) },
  });
  function request(teamId = "T-FOREIGN", secret = signingSecret) {
    const body = JSON.stringify({ type: "event_callback", team_id: teamId, event: { type: "message", text: "hello" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return new Request("https://paperclip.example/api/chat-webhooks/public/slack", { method: "POST", body,
      headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
  }
  return { refs, endpoint, rows, db, credentials, callbacks, resolveSecretValue, request,
    rotate: (value: string) => { signingSecret = value; } };
}

describe("Slack signing-secret preflight", () => {
  it("rejects a signed foreign workspace without resolving unrelated provider credentials", async () => {
    const f = fixture();
    const response = await f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request());
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("ignored");
    expect(f.resolveSecretValue).toHaveBeenCalledTimes(1);
    expect(f.resolveSecretValue).toHaveBeenCalledWith(f.endpoint.companyId, f.refs[1]!.secretId, "latest",
      expect.objectContaining({ consumerType: "tool_connection", consumerId: f.endpoint.connectionId,
        configPath: "credentials.signingSecret", actorType: "system" }));
  });

  it("continues the matching workspace without resolving unrelated credentials", async () => {
    const f = fixture();
    expect(await f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request("T-EXPECTED"))).toBeNull();
    expect(f.resolveSecretValue).toHaveBeenCalledTimes(1);
  });

  it("reads the current signing secret again after rotation", async () => {
    const f = fixture();
    expect((await f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request()))?.status).toBe(200);
    f.rotate("rotated-signing-secret");
    expect(await f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request("T-FOREIGN", "current-signing-secret"))).toBeNull();
    expect((await f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request()))?.status).toBe(200);
    expect(f.resolveSecretValue).toHaveBeenCalledTimes(3);
  });

  it("preserves signing-secret resolution failures", async () => {
    const f = fixture();
    f.resolveSecretValue.mockRejectedValue(new Error("Signing secret is revoked"));
    await expect(f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request())).rejects.toThrow("Signing secret is revoked");
  });

  it("preserves full runtime credential resolution", async () => {
    const f = fixture();
    f.resolveSecretValue.mockImplementation(async (_companyId, secretId) => f.refs.find(ref => ref.secretId === secretId)!.configPath);
    expect(await f.credentials.resolveCredentials(f.endpoint)).toEqual({
      botToken: "credentials.botToken", signingSecret: "credentials.signingSecret", appToken: "credentials.appToken",
    });
    expect(f.resolveSecretValue).toHaveBeenCalledTimes(3);
  });

  it("does not resolve credentials without a linked workspace", async () => {
    const f = fixture();
    expect(await f.callbacks.inspectSlackWebhookScope({ ...f.endpoint, providerAccountId: null }, f.request())).toBeNull();
    expect(f.db.select).not.toHaveBeenCalled();
    expect(f.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("preserves a missing connection failure", async () => {
    const f = fixture();
    f.rows.length = 0;
    await expect(f.callbacks.inspectSlackWebhookScope(f.endpoint, f.request())).rejects.toThrow("Chat connection not found");
  });
});
