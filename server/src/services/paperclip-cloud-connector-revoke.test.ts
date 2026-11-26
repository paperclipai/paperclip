import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPaperclipCloudConnector, type PaperclipCloudConnectorConfig } from "./paperclip-cloud-connector.js";

const companyId = "company_test";
const subject = "user_test";

function rawPrivateKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("missing private key bytes");
  return jwk.d;
}

function config() {
  return {
    config: {
      baseUrl: "https://my.example.test",
      instanceId: "inst_test",
      environment: "staging",
      signPrivateKey: rawPrivateKey(generateKeyPairSync("ed25519").privateKey),
      sealPrivateKey: rawPrivateKey(generateKeyPairSync("x25519").privateKey),
    } satisfies PaperclipCloudConnectorConfig,
  };
}

describe("Paperclip Cloud Google grant revocation", () => {
  function decodeClaims(request: string) {
    return JSON.parse(Buffer.from(request.split(".")[1]!, "base64url").toString("utf8"));
  }

  it("signs the Google profile, sends the refresh token only in the body, and returns the broker outcome", async () => {
    const bodies: Array<{ request: string; token: string }> = [];
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ localBindingRemoved: true, revokedAtProvider: false, outcome: "other_connections_remain" });
    });
    const connector = createPaperclipCloudConnector({ config: config().config, request: request as typeof fetch });
    await expect(connector.revoke({ subject, companyId, profile: "workspace.all", token: "refresh-secret" }))
      .resolves.toEqual({ outcome: "other_connections_remain" });
    expect(String(request.mock.calls[0]![0])).toBe("https://my.example.test/v1/connector/revoke");
    const claims = decodeClaims(bodies[0]!.request);
    expect(claims).toMatchObject({ op: "revoke", sub: subject, cid: companyId, prv: "google", prf: "workspace.all" });
    expect(claims.sh).toBe(createHash("sha256").update("refresh-secret").digest("base64url"));
    expect(bodies[0]!.token).toBe("refresh-secret");
    expect(bodies[0]!.request).not.toContain("refresh-secret");
  });

  it.each(["revoked", "provider_revocation_failed", "binding_not_known", "provider_revocation_disabled", "revocation_in_progress"])(
    "accepts the %s outcome",
    async (outcome) => {
      const connector = createPaperclipCloudConnector({ config: config().config,
        request: vi.fn(async () => Response.json({ outcome })) as typeof fetch });
      await expect(connector.revoke({ subject, companyId, profile: "gmail.read", token: "t" })).resolves.toEqual({ outcome });
    },
  );

  it("drops an unknown outcome", async () => {
    const connector = createPaperclipCloudConnector({ config: config().config,
      request: vi.fn(async () => Response.json({ outcome: "DO_NOT_REPORT" })) as typeof fetch });
    await expect(connector.revoke({ subject, companyId, profile: "gmail.read", token: "t" })).resolves.toEqual({});
  });

  it("reports an older broker's 409 as revocation not available", async () => {
    const connector = createPaperclipCloudConnector({ config: config().config,
      request: vi.fn(async () => Response.json({ error: "REVOCATION_NOT_AVAILABLE" }, { status: 409 })) as typeof fetch });
    await expect(connector.revoke({ subject, companyId, profile: "gmail.read", token: "t" }))
      .rejects.toMatchObject({ status: 409, brokerReason: "REVOCATION_NOT_AVAILABLE" });
  });

  it("aborts the broker call at the requested timeout", async () => {
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const connector = createPaperclipCloudConnector({ config: config().config, request: request as unknown as typeof fetch });
    const started = Date.now();
    await expect(connector.revoke({ subject, companyId, profile: "gmail.read", token: "t", timeoutMs: 50 }))
      .rejects.toMatchObject({ code: "CONNECTOR_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
