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
    expect((await probeAiAccountIdentity({ provider: "openai", method: "subscription" }, "", request)).errorCode).toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts a stalled real response body while unrelated requests remain responsive", async () => {
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
      const pending = probeAiAccountIdentity(metadata, "selected-credential", (_url, init) => fetch(`${origin}/profile`, init));
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
