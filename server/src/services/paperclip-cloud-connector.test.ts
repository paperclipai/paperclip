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
import { readFileSync } from "node:fs";

import {
  createPaperclipCloudConnector,
  invalidatePaperclipCloudConnectorCapabilities,
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

// Captured from the producer's in-memory HTTP integration test, using synthetic
// enrollment and a signed request with a callback outside the enrolled origins.
// Retain only the HTTP status and exact JSON error body, never request data.
const originRejectionContract = JSON.parse(readFileSync(
  new URL("./fixtures/cloud-connector-origin-rejection.json", import.meta.url), "utf8",
)) as { status: number; body: { error: string } };

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
  async function rejection(response: Response) {
    const connector = createPaperclipCloudConnector({
      config: config().config,
      request: vi.fn(async () => response) as typeof fetch,
    });
    return connector.startAuthorization({
      subject, companyId, profile: "gmail.read",
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "private-state",
    }).catch((error: unknown) => error);
  }

  it("accepts the producer's origin-rejection HTTP contract", async () => {
    expect(await rejection(Response.json(originRejectionContract.body, {
      status: originRejectionContract.status,
    }))).toMatchObject({
      code: "CONNECTOR_REQUEST_FAILED", status: 400,
      message: "Paperclip Cloud connector rejected the request (operation=session, status=400, reason=RETURN_ORIGIN_NOT_ENROLLED)",
    });
  });

  it("retains an allowlisted rejection reason without broker messages or credentials", async () => {
    const error = await rejection(Response.json({
      error: "RETURN_ORIGIN_NOT_ENROLLED",
      message: "DO_NOT_REPORT private-state access-secret https://private.example.test",
    }, { status: 400 }));
    expect(error).toBeInstanceOf(PaperclipCloudConnectorError);
    expect(error).toMatchObject({
      code: "CONNECTOR_REQUEST_FAILED", status: 400,
      message: "Paperclip Cloud connector rejected the request (operation=session, status=400, reason=RETURN_ORIGIN_NOT_ENROLLED)",
    });
    expect(JSON.stringify(error)).not.toMatch(/DO_NOT_REPORT|private-state|access-secret|private\.example/);
  });

  it.each([
    JSON.stringify({ error: "CUSTOM_SECRET_ERROR", message: "DO_NOT_REPORT" }),
    JSON.stringify({ error: { code: "RETURN_ORIGIN_NOT_ENROLLED" } }),
    "<html>DO_NOT_REPORT</html>",
    JSON.stringify({ error: "RETURN_ORIGIN_NOT_ENROLLED", padding: "x".repeat(4_096) }),
  ])("drops unknown, malformed, or oversized rejection bodies", async (body) => {
    const error = await rejection(new Response(body, { status: 409 }));
    expect(error).toMatchObject({
      code: "REAUTHORIZATION_REQUIRED", status: 409,
      message: "Paperclip Cloud connector rejected the request (operation=session, status=409, reason=UNKNOWN_BROKER_ERROR)",
    });
  });

  it("keeps the original status when the error body stream fails", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error("DO_NOT_REPORT")); },
    }), { status: 503 });
    expect(await rejection(response)).toMatchObject({
      code: "CONNECTOR_REQUEST_FAILED", status: 503,
      message: expect.stringContaining("reason=UNKNOWN_BROKER_ERROR"),
    });
  });

  it("keeps the original failure when a response body is absent or already locked", async () => {
    const locked = Response.json({ error: "RETURN_ORIGIN_NOT_ENROLLED" }, { status: 401 });
    const reader = locked.body!.getReader();
    try {
      for (const response of [new Response(null, { status: 401 }), locked]) {
        expect(await rejection(response)).toMatchObject({
          code: "CONNECTOR_REQUEST_FAILED", status: 401,
          message: expect.stringContaining("reason=UNKNOWN_BROKER_ERROR"),
        });
      }
    } finally {
      await reader.cancel();
    }
  });

  it("bounds a stalled diagnostic read and does not wait for cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    try {
      const pending = rejection(new Response(new ReadableStream({ cancel }), { status: 400 }));
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({
        code: "CONNECTOR_REQUEST_FAILED", status: 400,
        message: expect.stringContaining("reason=UNKNOWN_BROKER_ERROR"),
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes capabilities after enrollment and rejects stale cache writes", async () => {
    const keys = config().config;
    const env = {
      PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: keys.baseUrl,
      PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID: keys.instanceId,
      PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: keys.environment,
      PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: keys.signPrivateKey,
      PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: keys.sealPrivateKey,
    };
    let completeOldRequest!: (response: Response) => void;
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ status: "pending", active: false }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { completeOldRequest = resolve; }))
      .mockResolvedValue(Response.json({ status: "active", active: true, profiles: ["gmail.read"] }));
    invalidatePaperclipCloudConnectorCapabilities();
    try {
      await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual([]);
      await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
      invalidatePaperclipCloudConnectorCapabilities();
      const oldRequest = paperclipCloudConnectorCapabilitiesFromEnv(env);
      invalidatePaperclipCloudConnectorCapabilities();
      await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual(["gmail.read"]);
      completeOldRequest(Response.json({ status: "pending", active: false }));
      await expect(oldRequest).resolves.toEqual([]);
      await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual(["gmail.read"]);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      request.mockRestore();
      invalidatePaperclipCloudConnectorCapabilities();
    }
  });

  it.each(["chat.read", "chat.write"] as const)("signs reduced Chat scopes for %s", async (profile) => {
    const keys = config();
    const scopes = ["chat.spaces.readonly", "chat.messages.readonly", ...(profile === "chat.write" ? ["chat.messages.create"] : [])]
      .map((scope) => `https://www.googleapis.com/auth/${scope}`);
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const claims = JSON.parse(Buffer.from(body.request.split(".")[1], "base64url").toString("utf8"));
      expect(claims.prf).toBe(profile);
      expect(claims.scp).toEqual(scopes);
      return Response.json({ confirmationUrl: "https://my.example.test/connections/confirm?session=chat", expiresAt: "2099-01-01T00:00:00Z" });
    });
    const connector = createPaperclipCloudConnector({ config: keys.config, request: request as typeof fetch });
    await connector.startAuthorization({ subject, companyId, profile,
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback", returnState: "chat-state" });
    expect(request).toHaveBeenCalledOnce();
  });

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

  it("prefers a validated HTTPS provider URL over the legacy confirmation URL", async () => {
    const keys = config();
    const connector = createPaperclipCloudConnector({
      config: keys.config,
      request: vi.fn(async () => Response.json({
        confirmationUrl: "https://my.example.test/connections/confirm?session=broker-state",
        authorizationUrl: "https://github.com/login/oauth/authorize?client_id=client&state=broker-state",
        expiresAt: "2099-08-21T20:00:00.000Z",
      })) as typeof fetch,
    });

    await expect(connector.startAuthorization({
      subject,
      companyId,
      profile: "github.code",
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "state-direct",
    })).resolves.toMatchObject({
      authorizationUrl: "https://github.com/login/oauth/authorize?client_id=client&state=broker-state",
    });
  });

  it("accepts the fixed Google authorization endpoint for Google profiles", async () => {
    const keys = config();
    const connector = createPaperclipCloudConnector({
      config: keys.config,
      request: vi.fn(async () => Response.json({
        confirmationUrl: "https://my.example.test/connections/confirm?session=broker-state",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client&state=broker-state",
        expiresAt: "2099-08-21T20:00:00.000Z",
      })) as typeof fetch,
    });

    await expect(connector.startAuthorization({
      subject,
      companyId,
      profile: "gmail.draft",
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "state-direct-google",
    })).resolves.toMatchObject({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client&state=broker-state",
    });
  });

  it.each([
    ["non-string", { href: "https://github.com/login/oauth/authorize" }],
    ["plaintext HTTP", "http://github.com/login/oauth/authorize"],
    ["embedded credentials", "https://user:password@github.com/login/oauth/authorize"],
    ["fragment", "https://github.com/login/oauth/authorize#unexpected"],
    ["unapproved HTTPS origin", "https://attacker.example.test/login/oauth/authorize"],
    ["unapproved provider path", "https://github.com/session/authorize"],
    ["not a URL", "not-a-url"],
  ])("rejects a malformed direct provider URL: %s", async (_label, authorizationUrl) => {
    const keys = config();
    const connector = createPaperclipCloudConnector({
      config: keys.config,
      request: vi.fn(async () => Response.json({
        confirmationUrl: "https://my.example.test/connections/confirm?session=broker-state",
        authorizationUrl,
        expiresAt: "2099-08-21T20:00:00.000Z",
      })) as typeof fetch,
    });

    await expect(connector.startAuthorization({
      subject,
      companyId,
      profile: "github.code",
      returnUri: "https://paperclip.example.test/api/tools/oauth/cloud-connector/callback",
      returnState: "state-malformed-direct",
    })).rejects.toMatchObject({ code: "CONNECTOR_BAD_RESPONSE" });
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
