import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_CONTROL_AUDIENCE,
  CLOUD_CONTROL_HEADER,
  CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  resetCloudControlReplayFenceForTests,
} from "../../services/cloud-runtime-identity.js";
import {
  dotPrincipalControlDigest,
  dotPrincipalControlPath,
  type DotPrincipalControlBody,
  type DotPrincipalControlAuthority,
} from "./cloud-principal-authority.js";
import {
  McpOAuthError,
  type McpPrincipal,
  type PublicMcpOAuth,
} from "../../services/public-mcp/oauth.js";
import {
  dotPrincipalControlBodyParser,
  dotPrincipalControlRoutes,
  isDotPrincipalControlPost,
} from "./cloud-principal-http.js";

const pair = generateKeyPairSync("ed25519"),
  foreign = generateKeyPairSync("ed25519"),
  kid = "dot-control-unit";
const origin = "https://unit-dot.example.test",
  companyId = "11111111-1111-4111-8111-111111111111",
  grantId = "22222222-2222-4222-8222-222222222222";
const body: DotPrincipalControlBody = {
  accessToken: "original-unit-access",
  upstreamClientId: "upstream-client",
  selectingUserId: "selecting-user",
  canonicalVerifiedResource: origin + "/mcp/runner",
  expectedInstanceId: "instance",
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function fixture(ownerPresent = true) {
  let now = Date.now(),
    authority: DotPrincipalControlAuthority | null = {
      stackId: "stack",
      claimId: "claim",
      canonicalOrigin: origin,
      instanceId: "instance",
      environment: "test",
      baseUrl: "https://cloud.example.test",
      signPrivateKey: "private-unit-namespace-a",
      sealPrivateKey: "private-unit-namespace-b",
    };
  const principal: McpPrincipal = {
    grant: {
      id: grantId,
      companyId,
      userId: body.selectingUserId,
      clientId: body.upstreamClientId,
      resource: body.canonicalVerifiedResource,
      purpose: "agent",
      agentId: null,
      scopes: ["paperclip:agent"],
      revokedAt: null,
      revocationRevision: 0,
      revocationIndexReceipt: null,
      createdAt: new Date(0),
    },
    actor: { type: "none", source: "mcp_oauth", companyId },
    company: {
      id: companyId,
      name: "Unit",
      issuePrefix: "UNIT",
      status: "active",
    },
  };
  const authenticate = vi.fn(async (_token: string) => principal),
    readAuthority = vi.fn(() => authority);
  const oauth: Pick<PublicMcpOAuth, "mode" | "config" | "authenticate"> = {
    mode: "openai_dot_agent",
    config: { origin, resource: body.canonicalVerifiedResource },
    authenticate,
  };
  let downstreamActorCalls = 0;
  const actors: unknown[] = [],
    app = express();
  app.use((req, res, next) => {
    req.actor = { type: "none", source: "none" };
    res.on("finish", () => actors.push(req.actor.type));
    next();
  });
  app.use(dotPrincipalControlBodyParser());
  const json = express.json();
  app.use((req, res, next) =>
    isDotPrincipalControlPost(req) ? next() : json(req, res, next),
  );
  app.use(
    dotPrincipalControlRoutes(() => (ownerPresent ? oauth : null), {
      readAuthority,
      now: () => new Date(now),
    }),
  );
  app.use((_req, res) => {
    downstreamActorCalls++;
    res.status(599).end();
  });
  function assertion(
    value = body,
    changes: Record<string, unknown> = {},
    key = pair.privateKey,
  ) {
    const header = encode({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid }),
      iat = Math.floor(now / 1000),
      payload = encode({
        v: 1,
        iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
        aud: CLOUD_CONTROL_AUDIENCE,
        sub: "stack",
        action: "mcp-dot:principal",
        requestId: randomUUID() + "." + dotPrincipalControlDigest(value),
        iat,
        exp: iat + 60,
        ...changes,
      });
    return `${header}.${payload}.${sign(null, Buffer.from(header + "." + payload), key).toString("base64url")}`;
  }
  return {
    app,
    actors,
    authenticate,
    readAuthority,
    principal,
    assertion,
    downstream: () => downstreamActorCalls,
    change: (value: Partial<DotPrincipalControlAuthority>) => {
      authority = { ...authority!, ...value };
    },
    expire: () => {
      now += 61_000;
    },
    remove: () => {
      authority = null;
    },
  };
}
beforeEach(() => {
  resetCloudControlReplayFenceForTests();
  vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "stack");
  vi.stubEnv(
    "PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS",
    JSON.stringify({
      keys: [
        {
          ...pair.publicKey.export({ format: "jwk" }),
          kid,
          alg: "EdDSA",
          use: "sig",
        },
      ],
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCloudControlReplayFenceForTests();
});
describe("Dot private principal HTTP+real crypto UNIT; controlled OAuth/identity owners, no real PG", () => {
  it("reserves the actual HTTP path without an OAuth owner and never enters downstream actor work", async () => {
    const f = fixture(false);
    expect((await request(f.app).get(dotPrincipalControlPath)).status).toBe(
      405,
    );
    expect(
      (await request(f.app).post(dotPrincipalControlPath).send(body)).status,
    ).toBe(401);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set("Content-Type", "text/plain")
          .send("private")
      ).status,
    ).toBe(415);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, f.assertion())
          .set("Content-Type", "application/json")
          .send("{")
      ).status,
    ).toBe(400);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath.toUpperCase() + "/")
          .set(CLOUD_CONTROL_HEADER, f.assertion())
          .send(body)
      ).status,
    ).toBe(503);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, f.assertion())
          .send({ ...body, unknown: true })
      ).status,
    ).toBe(400);
    expect(f.downstream()).toBe(0);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
  });
  it("keeps the closed request tuple digest stable", () => {
    expect(dotPrincipalControlDigest(body)).toBe(
      "2c5172a91664f7df7d35b734cf8f355c51d2dde70eddcf15f4225673af3b88f5",
    );
  });
  it("returns minimal unpaired projection once, with unchanged none actor and no bearer echo", async () => {
    const f = fixture(),
      response = await request(f.app)
        .post(dotPrincipalControlPath + "/")
        .set(CLOUD_CONTROL_HEADER, f.assertion())
        .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: 1,
      stackId: "stack",
      instanceId: "instance",
      canonicalOrigin: origin,
      principal: {
        userId: body.selectingUserId,
        companyId,
        grantId,
        clientId: body.upstreamClientId,
        resource: body.canonicalVerifiedResource,
        purpose: "agent",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(body.accessToken);
    expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(body.accessToken);
    expect(f.readAuthority).toHaveBeenCalledTimes(2);
    expect(f.actors).toEqual(["none"]);
  });
  it("altered body cannot burn a valid request, and authentic replay is rejected", async () => {
    const f = fixture(),
      jws = f.assertion();
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, jws)
          .send({ ...body, accessToken: "altered" })
      ).status,
    ).toBe(401);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, jws)
          .send(body)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, jws)
          .send(body)
      ).status,
    ).toBe(401);
    expect(f.authenticate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { action: "mcp-device:mint" },
    { aud: "other" },
    { sub: "foreign" },
    { exp: 0 },
  ])(
    "rejects signed claim mismatch without OAuth or authority reads: %j",
    async (changes) => {
      const f = fixture();
      expect(
        (
          await request(f.app)
            .post(dotPrincipalControlPath)
            .set(CLOUD_CONTROL_HEADER, f.assertion(body, changes))
            .send(body)
        ).status,
      ).toBe(401);
      expect(f.authenticate).not.toHaveBeenCalled();
      expect(f.readAuthority).not.toHaveBeenCalled();
    },
  );
  it("rejects action lifetime over sixty seconds without consuming authority", async () => {
    const f = fixture(),
      iat = Math.floor(Date.now() / 1000);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, f.assertion(body, { iat, exp: iat + 120 }))
          .send(body)
      ).status,
    ).toBe(401);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
  });
  it("retains requested-company restriction and does not grant other HTTP methods", async () => {
    const f = fixture(),
      restricted = {
        ...body,
        requestedCompanyId: "33333333-3333-4333-8333-333333333333",
      };
    const result = await request(f.app)
      .post(dotPrincipalControlPath)
      .set(CLOUD_CONTROL_HEADER, f.assertion(restricted))
      .send(restricted);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_grant" });
    const methods = fixture();
    expect(
      (
        await request(methods.app)
          .get(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, methods.assertion())
      ).status,
    ).toBe(405);
    expect(methods.authenticate).not.toHaveBeenCalled();
    expect(methods.readAuthority).not.toHaveBeenCalled();
  });
  it("rejects absent/foreign signatures before identity/OAuth", async () => {
    const f = fixture();
    for (const jws of [
      undefined,
      "invalid",
      f.assertion(body, {}, foreign.privateKey),
    ]) {
      let sent = request(f.app).post(dotPrincipalControlPath);
      if (jws) sent = sent.set(CLOUD_CONTROL_HEADER, jws);
      expect((await sent.send(body)).status).toBe(401);
    }
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
  });
  it("enforces raw wire/type/strict-body bounds before owner calls", async () => {
    const f = fixture(),
      jws = f.assertion();
    for (const value of [
      { ...body, unknown: true },
      "{",
      { ...body, accessToken: "x".repeat(17_000) },
    ]) {
      const response = await request(f.app)
        .post(dotPrincipalControlPath)
        .set(CLOUD_CONTROL_HEADER, jws)
        .set("Content-Type", "application/json")
        .send(typeof value === "string" ? value : JSON.stringify(value));
      expect([400, 413]).toContain(response.status);
    }
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, jws)
          .set("Content-Type", "text/plain")
          .send("body")
      ).status,
    ).toBe(415);
    expect((await request(f.app).post(dotPrincipalControlPath)
      .set(CLOUD_CONTROL_HEADER, jws).set("Content-Type", "application/json")
      .send(Buffer.from([0xff]))).status).toBe(400);
    expect((await request(f.app).post(dotPrincipalControlPath)
      .set(CLOUD_CONTROL_HEADER, jws).set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip").send(gzipSync(JSON.stringify(body)))).status).toBe(400);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
  });
  it.each([
    { instanceId: "foreign" },
    { canonicalOrigin: "https://foreign.example.test" },
  ])("rejects current namespace mismatch before OAuth: %j", async (value) => {
    const f = fixture();
    f.change(value);
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, f.assertion())
          .send(body)
      ).status,
    ).toBe(503);
    expect(f.authenticate).not.toHaveBeenCalled();
  });
  it.each(["clientId", "userId", "companyId"] as const)(
    "preserves current OAuth principal %s restriction",
    async (field) => {
      const f = fixture();
      f.principal.grant[field] = "foreign";
      const response = await request(f.app)
        .post(dotPrincipalControlPath)
        .set(CLOUD_CONTROL_HEADER, f.assertion())
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "invalid_grant" });
      expect(f.authenticate).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["claimId", "instanceId", "signPrivateKey"] as const)(
    "fences %s rotation during actual helper await",
    async (field) => {
      const f = fixture();
      f.authenticate.mockImplementationOnce(async () => {
        f.change({ [field]: "replacement" });
        return f.principal;
      });
      expect(
        (
          await request(f.app)
            .post(dotPrincipalControlPath)
            .set(CLOUD_CONTROL_HEADER, f.assertion())
            .send(body)
        ).status,
      ).toBe(503);
      expect(f.authenticate).toHaveBeenCalledTimes(1);
    },
  );
  it("fences expiry after OAuth and preserves original owner rejection safely", async () => {
    const f = fixture();
    f.authenticate.mockImplementationOnce(async () => {
      f.expire();
      return f.principal;
    });
    expect(
      (
        await request(f.app)
          .post(dotPrincipalControlPath)
          .set(CLOUD_CONTROL_HEADER, f.assertion())
          .send(body)
      ).status,
    ).toBe(503);
    const other = fixture();
    other.authenticate.mockRejectedValueOnce(
      new McpOAuthError("invalid_grant", "private-detail"),
    );
    const response = await request(other.app)
      .post(dotPrincipalControlPath)
      .set(CLOUD_CONTROL_HEADER, other.assertion())
      .send(body);
    expect(response.body).toEqual({ error: "invalid_grant" });
  });
});
