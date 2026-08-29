import {
  createCipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createPaperclipIdGmailConnector,
  GMAIL_CONNECTOR_SCOPES,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  paperclipIdGmailConnectorConfigFromEnv,
  PaperclipIdConnectorError,
  type PaperclipIdGmailConnectorConfig,
} from "./paperclip-id-gmail-connector.js";

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
      baseUrl: "https://id.example.test",
      instanceId,
      environment: "staging",
      signPrivateKey: rawPrivateKey(signing.privateKey),
      sealPrivateKey: rawPrivateKey(sealing.privateKey),
    } satisfies PaperclipIdGmailConnectorConfig,
    sealPublicKey: sealing.publicKey,
  };
}

describe("Paperclip ID Gmail connector", () => {
  it("starts a signed session with exact endpoint audience and scope contract", async () => {
    const keys = config();
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string };
      const [, encodedClaims] = body.request.split(".");
      const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
      expect(claims).toMatchObject({
        iss: instanceId,
        aud: "https://id.example.test/api/connect/sessions",
        sub: subject,
        cid: companyId,
        env: "staging",
        op: "session",
        ruri: "https://paperclip.example.test/api/tools/oauth/paperclip-id/callback",
        rst: "state-1",
      });
      return Response.json({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=broker-state",
        expiresAt: "2026-08-21T20:00:00.000Z",
        scopes: [...GMAIL_CONNECTOR_SCOPES],
      }, { status: 201 });
    });
    const connector = createPaperclipIdGmailConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.startAuthorization({
      subject,
      companyId,
      returnUri: "https://paperclip.example.test/api/tools/oauth/paperclip-id/callback",
      returnState: "state-1",
    })).resolves.toMatchObject({ authorizationUrl: expect.stringContaining("accounts.google.com") });
  });

  it("opens an instance-sealed claim and verifies its user, company, and exact scopes", async () => {
    const keys = config();
    const credentials = {
      v: 1 as const,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      accessTokenExpiresAt: "2026-08-21T20:00:00.000Z",
      scopes: [...GMAIL_CONNECTOR_SCOPES],
      subject,
      companyId,
    };
    const sealed = seal(credentials, keys.sealPublicKey, "gmail-initial-tokens", keys.config);
    const request = vi.fn(async () => Response.json({
      claimId: "clm_test",
      scopes: [...GMAIL_CONNECTOR_SCOPES],
      sealed,
    }));
    const connector = createPaperclipIdGmailConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.claim({ subject, companyId, claimId: "clm_test" })).resolves.toEqual(credentials);
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
      scopes: [...GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profile].scopes],
      subject,
      companyId,
      profile,
    };
    const sealed = seal(credentials, keys.sealPublicKey, "google-workspace-initial-tokens", keys.config, profile);
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request: string };
      const [, encodedClaims] = body.request.split(".");
      const claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
      expect(claims.prf).toBe(profile);
      return Response.json({ claimId: "clm_drive", scopes: credentials.scopes, sealed });
    });
    const connector = createPaperclipIdGmailConnector({ config: keys.config, request: request as typeof fetch });

    await expect(connector.claim({ subject, companyId, profile, claimId: "clm_drive" })).resolves.toEqual(credentials);
  });

  it("accepts only the current capability protocol and known profiles", async () => {
    const keys = config();
    const request = vi.fn(async () => Response.json({
      protocolVersion: 2,
      profiles: ["gmail.read", "drive.write", "unknown.profile"],
    }));
    const connector = createPaperclipIdGmailConnector({ config: keys.config, request: request as typeof fetch });
    await expect(connector.getCapabilities()).resolves.toEqual(["gmail.read", "drive.write"]);
  });

  it("does not expose a broker response body when a request fails", async () => {
    const keys = config();
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: "provider rejected access-secret refresh-secret",
    }), { status: 502 }));
    const connector = createPaperclipIdGmailConnector({ config: keys.config, request: request as typeof fetch });

    const error = await connector.refresh({ subject, companyId, refreshToken: "refresh-secret" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PaperclipIdConnectorError);
    expect(String(error)).not.toContain("access-secret");
    expect(String(error)).not.toContain("refresh-secret");
    expect(request).toHaveBeenCalledOnce();
  });

  it("requires an all-or-nothing environment configuration and loopback for HTTP", () => {
    expect(paperclipIdGmailConnectorConfigFromEnv({})).toBeNull();
    expect(() => paperclipIdGmailConnectorConfigFromEnv({
      PAPERCLIP_ID_CONNECTOR_INSTANCE_ID: instanceId,
    })).toThrowError(/incomplete/);
    expect(() => paperclipIdGmailConnectorConfigFromEnv({
      PAPERCLIP_ID_CONNECTOR_INSTANCE_ID: instanceId,
      PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY: "key",
      PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY: "key",
      PAPERCLIP_ID_CONNECTOR_ENVIRONMENT: "development",
      PAPERCLIP_ID_CONNECTOR_BASE_URL: "http://id.example.test",
    })).toThrowError(/HTTPS/);
  });
});

function seal(
  payload: unknown,
  recipientPublicKey: KeyObject,
  purpose: "gmail-initial-tokens" | "gmail-access-token" | "google-workspace-initial-tokens" | "google-workspace-access-token",
  configValue: PaperclipIdGmailConnectorConfig,
  profile?: string,
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
    ...(profile ? [profile] : []),
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
    epk: ephemeralJwk.x,
    iv: iv.toString("base64url"),
    ct: ciphertext.toString("base64url"),
  };
}
