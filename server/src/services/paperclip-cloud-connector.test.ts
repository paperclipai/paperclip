import {
  createCipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createPaperclipCloudConnector,
  GMAIL_CONNECTOR_SCOPES,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  paperclipCloudConnectorCapabilitiesFromEnv,
  paperclipCloudConnectorConfigFromEnv,
  PaperclipCloudConnectorError,
  type PaperclipCloudConnectorConfig,
} from "./paperclip-cloud-connector.js";

const instanceId = "inst_test";
const companyId = "company_test";
const subject = "user_test";

function rawPrivateKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("missing private key bytes");
  return jwk.d;
}

function config() {
  const signing = generateKeyPairSync("ed25519");
  const sealing = generateKeyPairSync("x25519");
  return {
    config: {
      baseUrl: "https://my.example.test",
      instanceId,
      environment: "staging",
      signPrivateKey: rawPrivateKey(signing.privateKey),
      sealPrivateKey: rawPrivateKey(sealing.privateKey),
    } satisfies PaperclipCloudConnectorConfig,
    sealPublicKey: sealing.publicKey,
  };
}

describe("Paperclip Cloud connector", () => {
  it("starts a signed session with exact endpoint audience and scope contract", async () => {
    const keys = config();
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string };
      const [encodedHeader, encodedClaims] = body.request.split(".");
      expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8"))).toEqual({
        alg: "EdDSA",
        typ: "paperclip-cloud-connector-request+jwt",
      });
      const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
      expect(claims).toMatchObject({
        iss: instanceId,
        aud: "https://my.example.test/v1/connector/sessions",
        sub: subject,
        cid: companyId,
        env: "staging",
        op: "session",
        prv: "google",
        prf: "gmail.draft",
        scp: [...GMAIL_CONNECTOR_SCOPES],
        ruri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
        rst: "state-1",
      });
      return Response.json({
        confirmationUrl: "https://my.example.test/connections/confirm?session=broker-state",
        handoff: {
          kind: "tenant_background",
          session: "broker_state_abcdefghijklmnop",
        },
        expiresAt: "2026-08-21T20:00:00.000Z",
      }, { status: 201 });
    });
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.startAuthorization({
      subject,
      companyId,
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "state-1",
    })).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining("/connections/confirm"),
      handoff: {
        kind: "paperclip_cloud",
        session: "broker_state_abcdefghijklmnop",
      },
    });
  });

  it("binds active GitHub installations to proof from the current user token", async () => {
    const keys = config();
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string; binding: string };
      const claims = JSON.parse(Buffer.from(body.request.split(".")[1]!, "base64url").toString("utf8"));
      const binding = JSON.parse(body.binding);
      expect(binding).toEqual({
        id: "binding-1",
        installationId: "42",
        connectionId: "connection-1",
        grantId: "grant-1",
        active: true,
        accessToken: "ghu-user-token",
      });
      expect(claims.sh).toBe(createHash("sha256").update(body.binding).digest("base64url"));
      return Response.json({ active: true, installationId: "42" });
    });
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.setWebhookBinding({
      subject,
      companyId,
      id: "binding-1",
      installationId: "42",
      connectionId: "connection-1",
      grantId: "grant-1",
      active: true,
      accessToken: "ghu-user-token",
    })).resolves.toBeUndefined();
    await expect(connector.setWebhookBinding({
      subject,
      companyId,
      id: "binding-2",
      installationId: "43",
      connectionId: "connection-1",
      grantId: "grant-1",
      active: true,
    })).rejects.toMatchObject({ code: "CONNECTOR_CONFIG_INVALID" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy session responses compatible and rejects malformed handoff descriptors", async () => {
    const keys = config();
    const legacy = createPaperclipCloudConnector({
      config: keys.config,
      request: vi.fn(async () => Response.json({
        confirmationUrl: "https://my.example.test/connections/confirm?session=broker-state",
        expiresAt: "2099-08-21T20:00:00.000Z",
      })) as typeof fetch,
    });
    await expect(legacy.startAuthorization({
      subject,
      companyId,
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "state-legacy",
    })).resolves.not.toHaveProperty("handoff");

    const malformed = createPaperclipCloudConnector({
      config: keys.config,
      request: vi.fn(async () => Response.json({
        confirmationUrl: "https://my.example.test/connections/confirm?session=broker-state",
        handoff: { kind: "tenant_background", session: "not valid" },
        expiresAt: "2099-08-21T20:00:00.000Z",
      })) as typeof fetch,
    });
    await expect(malformed.startAuthorization({
      subject,
      companyId,
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "state-malformed",
    })).rejects.toMatchObject({ code: "CONNECTOR_BAD_RESPONSE" });
  });

  it("opens an instance-sealed claim and verifies its user, company, and exact scopes", async () => {
    const keys = config();
    const credentials = {
      v: 1 as const,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      accessTokenExpiresAt: "2026-08-21T20:00:00.000Z",
      refreshTokenExpiresAt: null,
      scopes: [...GMAIL_CONNECTOR_SCOPES],
      subject,
      companyId,
      instanceId,
      environment: "staging" as const,
      provider: "google" as const,
      profile: "gmail.draft",
    };
    const sealed = seal(credentials, keys.sealPublicKey, "initial", keys.config, "gmail.draft");
    const request = vi.fn(async () => Response.json({
      claimId: "clm_test",
      scopes: [...GMAIL_CONNECTOR_SCOPES],
      sealed,
    }));
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.claim({
      subject,
      companyId,
      claimId: "clm_test",
      redemptionId: "local-oauth-state-1",
    })).resolves.toEqual(credentials);
  });

  it("binds non-Gmail credentials and requests to their exact connector profile", async () => {
    const keys = config();
    const profile = "drive.read" as const;
    const credentials = {
      v: 1 as const,
      accessToken: "drive-access-secret",
      refreshToken: "drive-refresh-secret",
      tokenType: "Bearer",
      accessTokenExpiresAt: "2026-08-21T20:00:00.000Z",
      refreshTokenExpiresAt: null,
      scopes: [...GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profile].scopes],
      subject,
      companyId,
      instanceId,
      environment: "staging" as const,
      provider: "google" as const,
      profile,
    };
    const sealed = seal(credentials, keys.sealPublicKey, "initial", keys.config, profile);
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string };
      const [, encodedClaims] = body.request.split(".");
      const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
      expect(claims.prf).toBe(profile);
      expect(claims.rid).toBe("local-oauth-state-drive");
      return Response.json({ claimId: "clm_drive", scopes: credentials.scopes, sealed });
    });
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.claim({
      subject,
      companyId,
      profile,
      claimId: "clm_drive",
      redemptionId: "local-oauth-state-drive",
    })).resolves.toEqual(credentials);
  });

  it("accepts only the current capability protocol and known profiles", async () => {
    const keys = config();
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string };
      const [, encodedClaims] = body.request.split(".");
      const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
      expect(claims).toMatchObject({
        iss: instanceId,
        aud: "https://my.example.test/v1/connector/instance-status",
        sub: "instance-capabilities",
        cid: "instance-capabilities",
        env: "staging",
        op: "status",
      });
      expect(claims).not.toHaveProperty("prv");
      expect(claims).not.toHaveProperty("prf");
      expect(claims).not.toHaveProperty("scp");
      return Response.json({
        active: true,
        status: "active",
        profiles: ["gmail.read", "drive.write", "unknown.profile", "gmail.read"],
      });
    });
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });
    await expect(connector.getCapabilities()).resolves.toEqual(["gmail.read", "drive.write"]);
  });

  it("fails capability discovery closed for inactive, legacy, malformed, or rejected status responses", async () => {
    const keys = config();
    const responses = [
      Response.json({ active: false, status: "suspended", profiles: ["gmail.read"] }),
      Response.json({ active: true, status: "active" }),
      Response.json({ active: true, status: "active", profiles: "gmail.read" }),
      new Response("detail must not escape", { status: 403 }),
    ];
    for (const response of responses) {
      const connector = createPaperclipCloudConnector({
        config: keys.config,
        request: vi.fn(async () => response) as typeof fetch,
      });
      await expect(connector.getCapabilities()).resolves.toEqual([]);
    }
  });

  it("checks Cloud enrollment status with an instance-only signed request", async () => {
    const keys = config();
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string };
      const [, encodedClaims] = body.request.split(".");
      const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
      expect(claims).toMatchObject({
        iss: instanceId,
        aud: "https://my.example.test/v1/connector/instance-status",
        sub: "instance-status",
        cid: "instance-status",
        env: "staging",
        op: "status",
      });
      expect(claims).not.toHaveProperty("prv");
      expect(claims).not.toHaveProperty("prf");
      expect(claims).not.toHaveProperty("scp");
      return Response.json({ active: true, status: "active" });
    });
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.getInstanceStatus()).resolves.toBe("active");
  });

  it("treats an unknown Cloud enrollment as removed without exposing Cloud detail", async () => {
    const keys = config();
    const connector = createPaperclipCloudConnector({
      config: keys.config,
      request: vi.fn(async () => new Response("unknown instance detail", { status: 401 })) as typeof fetch,
    });

    await expect(connector.getInstanceStatus()).resolves.toBe("removed");
  });

  it("does not expose a broker response body when a request fails", async () => {
    const keys = config();
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: "provider rejected access-secret refresh-secret",
    }), { status: 502 }));
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });

    const error = await connector.refresh({ subject, companyId, refreshToken: "refresh-secret" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PaperclipCloudConnectorError);
    expect(String(error)).not.toContain("access-secret");
    expect(String(error)).not.toContain("refresh-secret");
    expect(request).toHaveBeenCalledOnce();
  });

  it("requires an all-or-nothing environment configuration and loopback for HTTP", () => {
    expect(paperclipCloudConnectorConfigFromEnv({})).toBeNull();
    expect(() => paperclipCloudConnectorConfigFromEnv({
      PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID: instanceId,
    })).toThrowError(/incomplete/);
    expect(() => paperclipCloudConnectorConfigFromEnv({
      PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID: instanceId,
      PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "key",
      PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "key",
      PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: "http://my.example.test",
    })).toThrowError(/HTTPS/);
    const legacyError = (() => {
      try {
        paperclipCloudConnectorConfigFromEnv({
          PAPERCLIP_ID_CONNECTOR_INSTANCE_ID: instanceId,
          PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY: "key",
          PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY: "key",
          PAPERCLIP_ID_CONNECTOR_ENVIRONMENT: "development",
          PAPERCLIP_ID_CONNECTOR_BASE_URL: "https://id.paperclip.app",
        });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(legacyError).toMatchObject({ code: "CONNECTOR_MIGRATION_REQUIRED" });
    expect(String(legacyError)).toContain("incompatible legacy protocol");
  });

  it("keeps gallery capability discovery available during incomplete enrollment", async () => {
    await expect(paperclipCloudConnectorCapabilitiesFromEnv({
      PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    })).resolves.toEqual([]);
  });
});

function seal(
  payload: unknown,
  recipientPublicKey: KeyObject,
  purpose: "initial" | "access",
  configValue: PaperclipCloudConnectorConfig,
  profile: keyof typeof GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
) {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralJwk = ephemeral.publicKey.export({ format: "jwk" }) as { x: string };
  const recipientJwk = recipientPublicKey.export({ format: "jwk" }) as { x: string };
  const ephemeralRaw = Buffer.from(ephemeralJwk.x, "base64url");
  const recipientRaw = Buffer.from(recipientJwk.x, "base64url");
  const aad = Buffer.from([
    1,
    "X25519-HKDF-SHA256-A256GCM",
    purpose,
    configValue.instanceId,
    configValue.environment,
    "google",
    profile,
    [...GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profile].scopes].sort().join(" "),
  ].join("\n"));
  const key = Buffer.from(hkdfSync(
    "sha256",
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey }),
    Buffer.concat([ephemeralRaw, recipientRaw]),
    aad,
    32,
  ));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    alg: "X25519-HKDF-SHA256-A256GCM",
    purpose,
    provider: "google",
    profile,
    epk: ephemeralJwk.x,
    iv: iv.toString("base64url"),
    ct: ciphertext.toString("base64url"),
  };
}
