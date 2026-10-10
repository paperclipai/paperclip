import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorityHostEnvelopeHash,
  authorityRequestHash,
  createAuthorityHostProof,
  digestAuthorityBearer,
  digestDispatchTicket,
  parseCompactJws,
  parseGovnaAuthorityConfig,
  verifyAuthorityStatement,
} from "./govna-approval-authority.js";

function signedStatement(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  type: string,
  payload: Record<string, unknown>,
) {
  const header = Buffer.from(JSON.stringify({
    alg: "ES256",
    typ: type,
    kid: "govna-statement-key-1",
  })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function signedRawStatement(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  header: string,
  payload: string,
) {
  const signingInput = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

describe("Govna approval-authority protocol", () => {
  it("enables exact-call delegation only for an allowlisted tool and explicit matched policy", () => {
    const config = {
      mode: "required",
      prepareEndpoint: "https://api.govna.io/approval-authority/v1/prepare",
      statusEndpoint: "https://api.govna.io/approval-authority/v1/status",
      cancelEndpoint: "https://api.govna.io/approval-authority/v1/cancel",
      approvalOrigin: "https://app.govna.io",
      resource: "https://mcp.govna.io/farmhub",
      trustId: "atr_01m4hfpth0emf9wpckns4ngbxt",
      trustRevision: 1,
      hostContextId: "farmhub-paperclip",
      localPolicyRevision: "policy-v1",
      connectionGeneration: 1,
      hostIssuer: "https://factory.farmhub.ag",
      hostProofAudience: "govna-approval-authority",
      statementIssuer: "https://api.govna.io",
      statementAudience: "farmhub-paperclip",
      hostKeyId: "farmhub-host-key-1",
      hostSigningKeySecretId: "secret-key-id",
      statementKeyId: "govna-statement-key-1",
      statementPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----",
      tools: ["send_email"],
    };

    expect(parseGovnaAuthorityConfig({ govnaApprovalAuthority: config }, [{
      policyType: "require_approval",
      config: { govnaDelegation: "delegable_exact_call" },
    }], "send_email")).toEqual(config);
    expect(parseGovnaAuthorityConfig({ govnaApprovalAuthority: config }, [{
      policyType: "require_approval",
      config: {},
    }], "send_email")).toBeNull();
    expect(() => parseGovnaAuthorityConfig({ govnaApprovalAuthority: config }, [{
      policyType: "require_approval",
      config: { govnaDelegation: "delegable_exact_call" },
    }], "delete_everything")).toThrow(/allowlisted/);
    expect(() => parseGovnaAuthorityConfig({ govnaApprovalAuthority: { ...config, bearer: "secret" } }, [{
      policyType: "require_approval",
      config: { govnaDelegation: "delegable_exact_call" },
    }], "send_email")).toThrow(/unknown field/);
  });

  it.each([
    {
      operation: "prepare" as const,
      endpoint: "https://authority.govna.test/approval-authority/v1/prepare",
      body: {
        trust_revision: 1,
        operation_id: "operation-1",
        host_context_id: "context-1",
        local_policy_revision: "policy-1",
        connection_generation: 1,
        name: "lookup",
      },
      expected: "cECzlEdW1L76o1g4vfOyfYBsEP9nCYBzCVkKjaw9uMs",
    },
    {
      operation: "status" as const,
      endpoint: "https://authority.govna.test/approval-authority/v1/status",
      body: {
        reservation_id: "arv_01j0000000e008000000000001",
        operation_id: "operation-1",
        trust_revision: 1,
      },
      expected: "HD4ioWkhnq4HHeIE7a9HecbdBnfpO0EzZS6aUmT-fhU",
    },
    {
      operation: "cancel" as const,
      endpoint: "https://authority.govna.test/approval-authority/v1/cancel",
      body: {
        reservation_id: "arv_01j0000000e008000000000001",
        operation_id: "operation-1",
        trust_revision: 1,
      },
      expected: "aUdX0uDPjtzfUJros8h0M8bO1R2vwz3_BcLF2BmgvdI",
    },
    {
      operation: "dispatch" as const,
      endpoint: "https://authority.govna.test/approval-authority/v1/dispatch",
      body: {
        reservation_id: "arv_01j0000000e008000000000001",
        operation_id: "operation-1",
        trust_revision: 1,
        ticket_digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        request_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        local_claim_id: "claim-1",
      },
      expected: "Nqj1YvuPguTOUQ0Kvm1E6xiCS8yzmMu5SWpJZq9JHDo",
    },
  ])("matches the Govna $operation host-envelope vector", ({ operation, endpoint, body, expected }) => {
    expect(authorityHostEnvelopeHash(operation, endpoint, body)).toBe(expected);
  });

  it("normalizes absent arguments and binds exact tool arguments", () => {
    expect(authorityRequestHash("lookup", undefined)).toBe(
      authorityRequestHash("lookup", {}),
    );
    expect(authorityRequestHash("lookup", { query: "soil" })).not.toBe(
      authorityRequestHash("lookup", { query: "water" }),
    );
    expect(authorityRequestHash("dose", { liters: 0.5 })).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => authorityRequestHash("dose", null as never)).toThrow(/arguments must be an object/);
    expect(() => authorityRequestHash("dose", [] as never)).toThrow(/arguments must be an object/);
    expect(() => authorityRequestHash("dose", { crop: "\ud800" })).toThrow(/noncharacter/);
    expect(() => authorityHostEnvelopeHash("prepare", "https://authority.govna.test/prepare", {
      trust_revision: 1,
      operation_id: "operation-1",
      host_context_id: "context-1",
      local_policy_revision: "policy-1",
      connection_generation: 1,
      name: "dose",
      arguments: null,
    })).toThrow(/arguments must be an object/);
  });

  it("uses canonical base64url SHA-256 digests for bearer and ticket binding", () => {
    expect(digestAuthorityBearer("synthetic-bearer")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digestDispatchTicket("synthetic-ticket")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digestAuthorityBearer("synthetic-bearer")).not.toBe(
      digestDispatchTicket("synthetic-ticket"),
    );
  });

  it("rejects duplicate signed JOSE members before JSON information loss", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => parseCompactJws(signedRawStatement(
      privateKey,
      '{"alg":"ES256","alg":"none","typ":"govna-authority-status+jwt","kid":"key"}',
      '{"state":"pending"}',
    ))).toThrow(/Duplicate JSON object key/);
    expect(() => parseCompactJws(signedRawStatement(
      privateKey,
      '{"alg":"ES256","typ":"govna-authority-status+jwt","kid":"key"}',
      '{"state":"pending","state":"approved"}',
    ))).toThrow(/Duplicate JSON object key/);
  });

  it("signs a strict ES256 host proof with dispatch-only local claim provenance", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const proof = createAuthorityHostProof({
      privateKey,
      keyId: "farmhub-host-key-1",
      issuer: "https://factory.farmhub.ag",
      audience: "https://app.govna.io/approval-authority",
      trustId: "atr_01j0000000e008000000000001",
      trustRevision: 1,
      bearer: "synthetic-bearer",
      operation: "dispatch",
      endpoint: "https://authority.govna.test/mcp",
      hostRequestHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      localClaimId: "claim-1",
      now: 1_800_000_000,
      challenge: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      statementId: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
    });

    const parsed = parseCompactJws(proof);
    expect(parsed.header).toEqual({
      alg: "ES256",
      typ: "govna-host-proof+jwt",
      kid: "farmhub-host-key-1",
    });
    expect(parsed.payload).toMatchObject({
      operation: "dispatch",
      local_claim_id: "claim-1",
      iat: 1_800_000_000,
      nbf: 1_800_000_000,
      exp: 1_800_000_030,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      ),
    ).toBe(true);
  });

  it("rejects unsafe endpoints, unknown fields, and invalid dispatch bindings", () => {
    expect(() =>
      authorityHostEnvelopeHash("status", "http://authority.govna.test/status", {
        reservation_id: "arv_01j0000000e008000000000001",
        operation_id: "operation-1",
        trust_revision: 1,
      }),
    ).toThrow();
    expect(() =>
      authorityHostEnvelopeHash("prepare", "https://authority.govna.test/prepare", {
        trust_revision: 1,
        operation_id: "operation-1",
        host_context_id: "context-1",
        local_policy_revision: "policy-1",
        connection_generation: 1,
        name: "lookup",
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      createAuthorityHostProof({
        privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
        keyId: "farmhub-host-key-1",
        issuer: "https://factory.farmhub.ag",
        audience: "https://app.govna.io/approval-authority",
        trustId: "atr_01j0000000e008000000000001",
        trustRevision: 1,
        bearer: "synthetic-bearer",
        operation: "prepare",
        endpoint: "https://authority.govna.test/prepare",
        hostRequestHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        localClaimId: "claim-not-allowed",
        now: 1_800_000_000,
        challenge: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        statementId: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      }),
    ).toThrow();
  });

  it("verifies a pinned pending statement and returns its immutable binding", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const payload = {
      iss: "https://authority.govna.test",
      aud: "farmhub-paperclip",
      version: 1,
      challenge: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      host_request_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      trust_id: "atr_01j0000000e008000000000001",
      trust_revision: 1,
      revocation_epoch: 1,
      host_key_id: "farmhub-host-key-1",
      organization_id: "org_01j0000000e008000000000001",
      oauth_client_id: "agt_01j0000000e008000000000001",
      actor_id: "usr_01j0000000e008000000000001",
      agent_id: "agt_01j0000000e008000000000002",
      session_id: "ses_01j0000000e008000000000001",
      grant_id: "grn_01j0000000e008000000000001",
      operation_id: "operation-1",
      host_context_id: "context-1",
      local_policy_revision: "policy-1",
      connection_generation: 1,
      resource: "https://authority.govna.test/mcp",
      connector_identity_id: "idn_01j0000000e008000000000001",
      tool_id: "ctl_01j0000000e008000000000001",
      tool_name: "lookup",
      snapshot_digest: "a".repeat(64),
      request_hash: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      evaluated_action_digest: "b".repeat(64),
      enforcement_revision: "c".repeat(64),
      reservation_id: "arv_01j0000000e008000000000001",
      approval_id: "apr_01j0000000e008000000000001",
      approval_expires_at: 1_800_000_600,
      approval_route_digest: "d".repeat(64),
      human_approval_required: true,
      iat: 1_800_000_000,
      nbf: 1_800_000_000,
      exp: 1_800_000_060,
      jti: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      state: "pending",
      approval_url: "https://app.govna.io/authority-approval?org=org_01j0000000e008000000000001&reservation=arv_01j0000000e008000000000001",
      safe_summary: "Approve lookup for the FarmHub agent",
    };
    const compact = signedStatement(privateKey, "govna-approval-authority+jwt", payload);

    const verified = verifyAuthorityStatement({
      compact,
      publicKey,
      keyId: "govna-statement-key-1",
      type: "pending",
      now: 1_800_000_001,
      expected: {
        iss: "https://authority.govna.test",
        aud: "farmhub-paperclip",
        challenge: payload.challenge,
        host_request_hash: payload.host_request_hash,
        trust_id: payload.trust_id,
        trust_revision: 1,
        host_key_id: "farmhub-host-key-1",
        operation_id: "operation-1",
        host_context_id: "context-1",
        local_policy_revision: "policy-1",
        connection_generation: 1,
        resource: "https://authority.govna.test/mcp",
        tool_name: "lookup",
        request_hash: payload.request_hash,
        human_approval_required: true,
      },
      approvalOrigin: "https://app.govna.io",
    });

    expect(verified.payload).toEqual(payload);
    expect(verified.payload.reservation_id).toBe("arv_01j0000000e008000000000001");

    const pendingStatusPayload = {
      ...payload,
      exp: 1_800_000_030,
      ticket_generation: null,
      decision_actor_id: null,
      decision_at: null,
      decision_evidence_id: null,
    };
    expect(verifyAuthorityStatement({
      compact: signedStatement(privateKey, "govna-authority-status+jwt", pendingStatusPayload),
      publicKey,
      keyId: "govna-statement-key-1",
      type: "status",
      now: 1_800_000_001,
      expected: { operation_id: payload.operation_id, reservation_id: payload.reservation_id },
      approvalOrigin: "https://app.govna.io",
    }).payload).toEqual(pendingStatusPayload);

    const approvedStatusPayload = {
      ...pendingStatusPayload,
      state: "approved",
      approval_url: null,
      safe_summary: null,
      ticket_generation: 1,
      decision_actor_id: "usr_01j0000000e008000000000002",
      decision_at: 1_800_000_000,
      decision_evidence_id: "evt_01j0000000e008000000000001",
    };
    expect(verifyAuthorityStatement({
      compact: signedStatement(privateKey, "govna-authority-status+jwt", approvedStatusPayload),
      publicKey,
      keyId: "govna-statement-key-1",
      type: "status",
      now: 1_800_000_001,
      expected: { operation_id: payload.operation_id, reservation_id: payload.reservation_id },
      approvalOrigin: "https://app.govna.io",
    }).payload).toEqual(approvedStatusPayload);
  });

  it("rejects an expired, substituted, or extra-field authority statement", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const compact = signedStatement(privateKey, "govna-authority-status+jwt", {
      iss: "https://authority.govna.test",
      aud: "farmhub-paperclip",
      version: 1,
      challenge: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      host_request_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      trust_id: "atr_01j0000000e008000000000001",
      trust_revision: 1,
      revocation_epoch: 1,
      host_key_id: "farmhub-host-key-1",
      organization_id: "org_01j0000000e008000000000001",
      oauth_client_id: "agt_01j0000000e008000000000001",
      actor_id: "usr_01j0000000e008000000000001",
      agent_id: null,
      session_id: "ses_01j0000000e008000000000001",
      grant_id: "grn_01j0000000e008000000000001",
      operation_id: "operation-1",
      host_context_id: "context-1",
      local_policy_revision: "policy-1",
      connection_generation: 1,
      resource: "https://authority.govna.test/mcp",
      connector_identity_id: "idn_01j0000000e008000000000001",
      tool_id: "ctl_01j0000000e008000000000001",
      tool_name: "lookup",
      snapshot_digest: "a".repeat(64),
      request_hash: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      evaluated_action_digest: "b".repeat(64),
      enforcement_revision: "c".repeat(64),
      reservation_id: "arv_01j0000000e008000000000001",
      approval_id: "apr_01j0000000e008000000000001",
      approval_expires_at: 1_800_000_600,
      approval_route_digest: "d".repeat(64),
      human_approval_required: true,
      iat: 1_800_000_000,
      nbf: 1_800_000_000,
      exp: 1_800_000_030,
      jti: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      state: "pending",
      approval_url: "https://app.govna.io/authority-approval?org=org_01j0000000e008000000000001&reservation=arv_01j0000000e008000000000001",
      safe_summary: "Review lookup",
      unexpected: true,
    });
    expect(() => verifyAuthorityStatement({
      compact,
      publicKey,
      keyId: "govna-statement-key-1",
      type: "status",
      now: 1_800_000_031,
      expected: { aud: "another-host" },
      approvalOrigin: "https://app.govna.io",
    })).toThrow();
  });
});
