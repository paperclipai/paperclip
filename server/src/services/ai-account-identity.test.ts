import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { probeAiAccountIdentity } from "./ai-account-identity.js";

const metadata = { provider: "anthropic", method: "subscription" } as const;
function fixture(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
}

describe("AI account identity", () => {
  it("returns only safe account details from the selected bearer profile", async () => {
    const request = fixture({ account: { uuid: "private-seat", email: "avery@example.test", secret: "provider-private" },
      organization: { uuid: "private-organization", name: "Example team" }, access_token: "private-token" });
    const result = await probeAiAccountIdentity(metadata, "selected-credential", request);
    expect(result).toMatchObject({ status: "available", accountLabel: "avery@example.test", organizationLabel: "Example team" });
    expect(request).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/profile", expect.objectContaining({
      redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer selected-credential", "anthropic-beta": "oauth-2025-04-20" },
    }));
    for (const secret of ["private-seat", "private-organization", "provider-private", "private-token", "selected-credential"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it.each([401, 403, 429, 500])("reports HTTP %s without exposing the provider response", async status => {
    const result = await probeAiAccountIdentity(metadata, "selected-credential", fixture({ error: "private-provider-error" }, status));
    expect(result).toMatchObject({ accountLabel: null, organizationLabel: null });
    expect(result.status).toBe(status === 401 || status === 403 ? "unavailable" : "error");
    if (status === 403) expect(result).toMatchObject({ errorCode: "permission_denied", message: expect.stringContaining("did not permit") });
    expect(JSON.stringify(result)).not.toContain("private-provider-error");
  });

  it.each([{}, { account: { email: "not-an-email" } }, { account: { email: "avery@example.test\nprivate" } }])("does not infer an email from an incomplete profile %j", async profile => {
    expect(await probeAiAccountIdentity(metadata, "selected-credential", fixture(profile))).toMatchObject({
      status: "unavailable", errorCode: "invalid_response", accountLabel: null,
    });
  });

  it("does not call a provider for API keys or other sign-in methods", async () => {
    const request = fixture({});
    expect((await probeAiAccountIdentity({ provider: "anthropic", method: "api_key" }, "", request)).errorCode).toBe("unsupported");
    expect((await probeAiAccountIdentity({ provider: "google", method: "subscription" }, "", request)).errorCode).toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
  });

  const openai = { provider: "openai", method: "subscription" } as const;
  const openaiCredential = JSON.stringify({ tokens: { access_token: "selected-openai-bearer", account_id: "selected-workspace" } });

  it("reads the selected OpenAI workspace rather than the default or first workspace", async () => {
    const request = fixture({ default_account_id: "other-workspace", accounts: {
      "other-workspace": { account: { account_id: "other-workspace", name: "Other team", structure: "workspace" } },
      "selected-workspace": { account: { account_id: "selected-workspace", name: "Example business", structure: "workspace", private_field: "private-provider-data" } },
    } });
    const result = await probeAiAccountIdentity(openai, openaiCredential, request);
    expect(result).toMatchObject({ status: "available", organizationLabel: "Example business" });
    expect(request).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/accounts/check", expect.objectContaining({
      redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer selected-openai-bearer", "ChatGPT-Account-Id": "selected-workspace" },
    }));
    for (const value of ["selected-openai-bearer", "selected-workspace", "private-provider-data", "Other team"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it("supports the provider's list response and legacy saved credentials", async () => {
    const result = await probeAiAccountIdentity(openai, JSON.stringify({ accessToken: "selected-openai-bearer", accountId: "selected-workspace" }),
      fixture({ accounts: [{ id: "selected-workspace", name: "Example business", structure: "workspace" }] }));
    expect(result).toMatchObject({ status: "available", organizationLabel: "Example business" });
  });

  it("identifies a personal workspace when OpenAI supplies its type without a name", async () => {
    expect(await probeAiAccountIdentity(openai, openaiCredential, fixture({ accounts: {
      "selected-workspace": { account: { account_id: "selected-workspace", structure: "personal" } },
    } }))).toMatchObject({ status: "available", organizationLabel: "Personal workspace" });
  });

  it.each([
    {},
    { accounts: [{ id: "other-workspace", name: "Other team" }] },
    { accounts: [{ id: "selected-workspace", name: "First" }, { id: "selected-workspace", name: "Second" }] },
    { accounts: { "selected-workspace": { account: { account_id: "other-workspace", name: "Wrong team" } } } },
    { accounts: [{ id: "selected-workspace", name: "Deactivated team", is_deactivated: true }] },
    { accounts: [{ id: "selected-workspace", name: "Unsafe\nname" }] },
    { accounts: [{ id: "selected-workspace", name: "x".repeat(255) }] },
    { accounts: [{ id: "selected-workspace", structure: "workspace" }] },
  ])("does not guess the OpenAI workspace from an incomplete or ambiguous response %j", async profile => {
    expect(await probeAiAccountIdentity(openai, openaiCredential, fixture(profile))).toMatchObject({
      status: "unavailable", errorCode: "invalid_response", organizationLabel: null,
    });
  });

  it.each(["", "not-json", "{}", JSON.stringify({ tokens: { access_token: "bearer" } })])("does not make an unscoped OpenAI request for %s", async credential => {
    const request = fixture({});
    expect(await probeAiAccountIdentity(openai, credential, request)).toMatchObject({ status: "unavailable", errorCode: "authentication_required" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("reports OpenAI HTTP %s without leaking details or naming another provider", async status => {
    const result = await probeAiAccountIdentity(openai, openaiCredential, fixture({ error: "private-provider-error" }, status));
    expect(result.status).toBe(status === 401 || status === 403 ? "unavailable" : "error");
    expect(result.organizationLabel).toBeNull();
    expect(result.message).not.toContain("Anthropic");
    expect(JSON.stringify(result)).not.toContain("private-provider-error");
  });

  it.each([metadata, openai])("aborts a stalled $provider response body while unrelated requests remain responsive", async provider => {
    const server = createServer((req, res) => {
      if (req.url === "/profile") { res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); }
      else res.end("responsive");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(100));
    try {
      const pending = probeAiAccountIdentity(provider, provider.provider === "openai" ? openaiCredential : "selected-credential", (_url, init) => fetch(`${origin}/profile`, init));
      expect(await (await fetch(`${origin}/unrelated`)).text()).toBe("responsive");
      const result = await pending;
      expect(result.status).toBe("error");
      expect(result.accountLabel).toBeNull();
      expect(deadline).toHaveBeenCalledWith(15_000);
    } finally {
      deadline.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
