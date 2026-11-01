import { describe, expect, it } from "vitest";
import { aiConnectionPoolMemberSchema, type AiManagedConnectionSummary } from "@paperclipai/shared";
import { memberOf } from "./AiConnectionPoolConnector";

function accountOf(kind: "gateway" | "local", protocol: "chat" | "responses" | "messages", model: string): AiManagedConnectionSummary {
  return {
    id: "connection", grantId: "grant", companyId: "company", provider: "openai", method: "api_key", name: "Gateway", ownership: "personal", isDefault: false, status: "connected",
    routing: { kind, protocol, auth: "bearer", baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [{ id: model }] },
  };
}

describe("connection pool member defaults", () => {
  it.each(["gateway", "local"] as const)("uses OpenCode and the raw model for a chat %s connection", (kind) => {
    expect(memberOf(accountOf(kind, "chat", `${kind}-chat-model`)).profile).toEqual({ provider: "opencode", model: `${kind}-chat-model` });
  });
  it.each(["gateway", "local"] as const)("requires a model when a chat %s inventory is empty", (kind) => {
    const account = accountOf(kind, "chat", "model");
    const member = memberOf({ ...account, routing: { ...account.routing!, models: [] } });
    expect(member.profile).toEqual({ provider: "opencode", model: "" });
    expect(aiConnectionPoolMemberSchema.shape.profile.shape.model.safeParse(member.profile.model).success).toBe(false);
  });
  it.each(["gateway", "local"] as const)("preserves the first raw model when chat %s hints include colliding routed names", (kind) => {
    const account = accountOf(kind, "chat", "custom/a");
    expect(memberOf({ ...account, routing: { ...account.routing!, models: [{ id: "custom/a" }, { id: "paperclip/custom/a" }] } }).profile.model).toBe("custom/a");
    expect(memberOf({ ...account, routing: { ...account.routing!, models: [{ id: "paperclip/custom/a" }, { id: "custom/a" }] } }).profile.model).toBe("paperclip/custom/a");
  });
  it.each([
    ["gateway", "responses", { provider: "codex", model: "gateway-responses-model" }],
    ["gateway", "messages", { provider: "acpx", acpxAgent: "claude", model: "gateway-messages-model" }],
    ["local", "responses", { provider: "codex", model: "local-responses-model" }],
    ["local", "messages", { provider: "acpx", acpxAgent: "claude", model: "local-messages-model" }],
  ] as const)("uses the %s %s protocol instead of the provider name", (kind, protocol, profile) => {
    expect(memberOf(accountOf(kind, protocol, profile.model)).profile).toEqual(profile);
  });
  it("accepts 267-character pool model IDs and rejects 268 characters", () => {
    const account = { ...accountOf("gateway", "chat", "model"), id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
    const member = memberOf(account);
    expect(aiConnectionPoolMemberSchema.parse({ ...member, profile: { ...member.profile, model: "m".repeat(267) } }).profile.model).toHaveLength(267);
    expect(aiConnectionPoolMemberSchema.safeParse({ ...member, profile: { ...member.profile, model: "m".repeat(268) } }).success).toBe(false);
  });
  it("keeps a maximum-length raw chat model ID serializable", () => {
    const raw = "m".repeat(256);
    const account = { ...accountOf("gateway", "chat", raw), id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
    const member = memberOf(account);
    expect(member.profile.model).toBe(raw);
    expect(aiConnectionPoolMemberSchema.parse(member).profile.model).toHaveLength(256);
  });
});
