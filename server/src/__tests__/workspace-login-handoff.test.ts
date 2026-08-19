import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceHandoffExchangeUrl,
  deriveWorkspaceHandoffKey,
  deriveWorkspaceReadinessToken,
  issueWorkspaceHandoffTicket,
  normalizeWorkspaceHandoffOrigin,
  redactWorkspaceHandoffTicket,
  resolveWorkspaceHandoffRootSecret,
  sanitizeWorkspaceHandoffRedirectPath,
  verifyWorkspaceHandoffTicket,
  WORKSPACE_HANDOFF_TICKET_VERSION,
} from "../auth/workspace-login-handoff.js";
import {
  exchangeWorkspaceHandoffTicket,
  isWorkspaceHandoffRepairReason,
  workspaceHandoffFailureStatus,
  type WorkspaceHandoffExchangeDeps,
} from "../auth/workspace-login-handoff-exchange.js";

const ROOT_SECRET = "root-secret-for-tests";
const INSTANCE_ID = "pap-17572-workspace-abc123def456";
const EXECUTION_WORKSPACE_ID = "ews-1111-2222";
const COMPANY_ID = "company-1111";
const ORIGIN = "https://workspace.example.ts.net:42013";
const USER_ID = "user-1";
const USER_EMAIL = "Operator@Example.com";

const KEY = deriveWorkspaceHandoffKey({
  rootSecret: ROOT_SECRET,
  instanceId: INSTANCE_ID,
  executionWorkspaceId: EXECUTION_WORKSPACE_ID,
});

const EXPECTED = {
  instanceId: INSTANCE_ID,
  executionWorkspaceId: EXECUTION_WORKSPACE_ID,
  companyId: COMPANY_ID,
  origin: ORIGIN,
};

function mintTicket(overrides: Partial<Parameters<typeof issueWorkspaceHandoffTicket>[0]> = {}) {
  return issueWorkspaceHandoffTicket({
    key: KEY,
    userId: USER_ID,
    email: USER_EMAIL,
    executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    companyId: COMPANY_ID,
    instanceId: INSTANCE_ID,
    origin: ORIGIN,
    issuerInstanceId: "primary",
    ...overrides,
  });
}

function exchangeDeps(overrides: Partial<WorkspaceHandoffExchangeDeps> = {}) {
  const reserved = new Set<string>();
  return {
    findClonedIdentity: vi.fn(async ({ userId }: { userId: string; companyId: string }) =>
      userId === USER_ID
        ? { userId, email: USER_EMAIL, hasActiveMembership: true }
        : null,
    ),
    reserveNonce: vi.fn(async ({ nonce }: { nonce: string }) => {
      if (reserved.has(nonce)) return false;
      reserved.add(nonce);
      return true;
    }),
    createSession: vi.fn(async () => undefined),
    ...overrides,
  } satisfies WorkspaceHandoffExchangeDeps;
}

describe("workspace handoff key derivation", () => {
  it("derives a distinct key per instance and per workspace", () => {
    const otherWorkspace = deriveWorkspaceHandoffKey({
      rootSecret: ROOT_SECRET,
      instanceId: INSTANCE_ID,
      executionWorkspaceId: "ews-other",
    });
    const otherInstance = deriveWorkspaceHandoffKey({
      rootSecret: ROOT_SECRET,
      instanceId: "other-instance",
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    });
    expect(KEY).not.toBe(otherWorkspace);
    expect(KEY).not.toBe(otherInstance);
    expect(KEY).not.toContain(ROOT_SECRET);
  });

  it("keeps the readiness probe token separate from the signing key", () => {
    const token = deriveWorkspaceReadinessToken({
      rootSecret: ROOT_SECRET,
      instanceId: INSTANCE_ID,
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    });
    expect(token).not.toBe(KEY);
  });

  it("prefers a dedicated secret and otherwise derives one that is not the auth secret", () => {
    expect(
      resolveWorkspaceHandoffRootSecret({ PAPERCLIP_WORKSPACE_HANDOFF_SECRET: "dedicated" }),
    ).toEqual({ secret: "dedicated", source: "dedicated" });

    const derived = resolveWorkspaceHandoffRootSecret({ BETTER_AUTH_SECRET: "auth-secret" });
    expect(derived?.source).toBe("derived");
    expect(derived?.secret).not.toBe("auth-secret");

    expect(resolveWorkspaceHandoffRootSecret({})).toBeNull();
  });
});

describe("verifyWorkspaceHandoffTicket", () => {
  it("accepts a ticket bound to this workspace", () => {
    const { ticket, payload } = mintTicket({ next: "/PAP/issues/PAP-1" });
    const result = verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED });
    expect(result).toEqual({ ok: true, payload });
  });

  it("rejects a ticket signed with another workspace's key", () => {
    const foreignKey = deriveWorkspaceHandoffKey({
      rootSecret: ROOT_SECRET,
      instanceId: INSTANCE_ID,
      executionWorkspaceId: "ews-other",
    });
    const { ticket } = mintTicket({ key: foreignKey });
    expect(verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a ticket minted for another origin, workspace, or instance", () => {
    const wrongOrigin = mintTicket({ origin: "https://other.example.ts.net:42099" });
    expect(verifyWorkspaceHandoffTicket({ ticket: wrongOrigin.ticket, key: KEY, expected: EXPECTED }).ok).toBe(false);
    expect(
      verifyWorkspaceHandoffTicket({ ticket: wrongOrigin.ticket, key: KEY, expected: EXPECTED }),
    ).toEqual({ ok: false, reason: "origin_mismatch" });

    // A ticket for a sibling workspace on the same host cannot be re-signed with
    // this workspace's key, so bind-mismatch is proven with a matching key.
    const siblingWorkspaceKey = KEY;
    const wrongWorkspace = issueWorkspaceHandoffTicket({
      key: siblingWorkspaceKey,
      userId: USER_ID,
      email: USER_EMAIL,
      executionWorkspaceId: "ews-sibling",
      companyId: COMPANY_ID,
      instanceId: INSTANCE_ID,
      origin: ORIGIN,
      issuerInstanceId: "primary",
    });
    expect(verifyWorkspaceHandoffTicket({ ticket: wrongWorkspace.ticket, key: KEY, expected: EXPECTED })).toEqual({
      ok: false,
      reason: "workspace_mismatch",
    });

    const wrongInstance = issueWorkspaceHandoffTicket({
      key: KEY,
      userId: USER_ID,
      email: USER_EMAIL,
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      companyId: COMPANY_ID,
      instanceId: "some-other-instance",
      origin: ORIGIN,
      issuerInstanceId: "primary",
    });
    expect(verifyWorkspaceHandoffTicket({ ticket: wrongInstance.ticket, key: KEY, expected: EXPECTED })).toEqual({
      ok: false,
      reason: "instance_mismatch",
    });
  });

  it("rejects a ticket minted for another company on the same workspace", () => {
    // The signing key is per workspace, so a same-host sibling company shares it —
    // which is exactly why the company has to be bound and compared.
    const { ticket } = mintTicket({ companyId: "company-other" });
    expect(verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED })).toEqual({
      ok: false,
      reason: "company_mismatch",
    });
  });

  it("rejects an expired ticket and one issued in the future", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const { ticket } = mintTicket({ now, ttlSeconds: 30 });
    expect(
      verifyWorkspaceHandoffTicket({
        ticket,
        key: KEY,
        expected: EXPECTED,
        now: new Date(now.getTime() + 121_000),
      }),
    ).toEqual({ ok: false, reason: "expired" });

    expect(
      verifyWorkspaceHandoffTicket({
        ticket,
        key: KEY,
        expected: EXPECTED,
        now: new Date(now.getTime() - 120_000),
      }),
    ).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("fails closed when local identity cannot be resolved", () => {
    const { ticket } = mintTicket();
    expect(
      verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: { ...EXPECTED, origin: null } }),
    ).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(
      verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: { ...EXPECTED, instanceId: null } }),
    ).toEqual({ ok: false, reason: "instance_mismatch" });
    expect(
      verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: { ...EXPECTED, executionWorkspaceId: null } }),
    ).toEqual({ ok: false, reason: "workspace_mismatch" });
    expect(
      verifyWorkspaceHandoffTicket({ ticket, key: KEY, expected: { ...EXPECTED, companyId: null } }),
    ).toEqual({ ok: false, reason: "company_mismatch" });
    expect(verifyWorkspaceHandoffTicket({ ticket, key: "", expected: EXPECTED })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("rejects malformed, truncated, and re-versioned tickets", () => {
    const { ticket } = mintTicket();
    const [version, payload, signature] = ticket.split(".");
    expect(verifyWorkspaceHandoffTicket({ ticket: "", key: KEY, expected: EXPECTED }).ok).toBe(false);
    expect(verifyWorkspaceHandoffTicket({ ticket: `${version}.${payload}`, key: KEY, expected: EXPECTED })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      verifyWorkspaceHandoffTicket({ ticket: `wh0.${payload}.${signature}`, key: KEY, expected: EXPECTED }),
    ).toEqual({ ok: false, reason: "unsupported_version" });
    expect(
      verifyWorkspaceHandoffTicket({ ticket: `${version}.${payload}.not+base64url`, key: KEY, expected: EXPECTED }),
    ).toEqual({ ok: false, reason: "malformed" });
    // Payload tampering has to fail on the signature, never on JSON parsing.
    const tampered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sub: "attacker" }),
    ).toString("base64url");
    expect(
      verifyWorkspaceHandoffTicket({ ticket: `${version}.${tampered}.${signature}`, key: KEY, expected: EXPECTED }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("uses the declared envelope version", () => {
    expect(mintTicket().ticket.startsWith(`${WORKSPACE_HANDOFF_TICKET_VERSION}.`)).toBe(true);
  });
});

describe("exchangeWorkspaceHandoffTicket", () => {
  it("creates exactly one session for a valid ticket", async () => {
    const { ticket } = mintTicket({ next: "/PAP/issues/PAP-2" });
    const deps = exchangeDeps();
    const result = await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps });
    expect(result.ok).toBe(true);
    expect(result.ok && result.redirectTo).toBe("/PAP/issues/PAP-2");
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect(deps.createSession).toHaveBeenCalledWith(USER_ID);
  });

  it("rejects a replayed ticket without creating a second session", async () => {
    const { ticket } = mintTicket();
    const deps = exchangeDeps();
    expect((await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps })).ok).toBe(true);
    const replay = await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps });
    expect(replay).toEqual({ ok: false, reason: "replayed", payload: expect.objectContaining({ sub: USER_ID }) });
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });

  it("asks for membership in the ticket's company, not any membership", async () => {
    const { ticket } = mintTicket();
    const deps = exchangeDeps();
    expect((await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps })).ok).toBe(true);
    expect(deps.findClonedIdentity).toHaveBeenCalledWith({ userId: USER_ID, companyId: COMPANY_ID });
  });

  it("reports a missing cloned user and a missing membership distinctly", async () => {
    const { ticket } = mintTicket();
    const missingUser = exchangeDeps({ findClonedIdentity: vi.fn(async () => null) });
    expect(
      (await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps: missingUser })),
    ).toMatchObject({ ok: false, reason: "unknown_user" });
    expect(missingUser.createSession).not.toHaveBeenCalled();

    const noMembership = exchangeDeps({
      findClonedIdentity: vi.fn(async () => ({ userId: USER_ID, email: USER_EMAIL, hasActiveMembership: false })),
    });
    expect(
      (await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps: noMembership })),
    ).toMatchObject({ ok: false, reason: "missing_membership" });
    expect(noMembership.reserveNonce).not.toHaveBeenCalled();
    expect(noMembership.createSession).not.toHaveBeenCalled();
  });

  it("rejects a clone whose user id was reused for a different email", async () => {
    const { ticket } = mintTicket();
    const deps = exchangeDeps({
      findClonedIdentity: vi.fn(async () => ({
        userId: USER_ID,
        email: "someone-else@example.com",
        hasActiveMembership: true,
      })),
    });
    expect(
      await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps }),
    ).toMatchObject({ ok: false, reason: "user_mismatch" });
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it("matches the cloned email case-insensitively", async () => {
    const { ticket } = mintTicket();
    const deps = exchangeDeps({
      findClonedIdentity: vi.fn(async () => ({
        userId: USER_ID,
        email: USER_EMAIL.toUpperCase(),
        hasActiveMembership: true,
      })),
    });
    expect((await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps })).ok).toBe(true);
  });

  it("burns the nonce when session creation fails so a captured ticket cannot be retried", async () => {
    const { ticket } = mintTicket();
    const deps = exchangeDeps({
      createSession: vi.fn(async () => {
        throw new Error("session store unavailable");
      }),
    });
    expect(
      await exchangeWorkspaceHandoffTicket({ ticket, key: KEY, expected: EXPECTED, deps }),
    ).toMatchObject({ ok: false, reason: "session_failed" });
    expect(deps.reserveNonce).toHaveBeenCalledTimes(1);
  });

  it("never consults request headers: identity comes only from `expected`", async () => {
    // A ticket minted for the spoofed host fails against the configured origin,
    // which is the whole forwarded-header defense.
    const spoofed = mintTicket({ origin: "https://attacker.example.com" });
    expect(
      await exchangeWorkspaceHandoffTicket({
        ticket: spoofed.ticket,
        key: KEY,
        expected: EXPECTED,
        deps: exchangeDeps(),
      }),
    ).toEqual({ ok: false, reason: "origin_mismatch", payload: null });
  });

  it("maps failures onto stable statuses that do not leak which check failed", () => {
    expect(workspaceHandoffFailureStatus("not_configured")).toBe(503);
    expect(workspaceHandoffFailureStatus("session_failed")).toBe(500);
    for (const reason of ["expired", "replayed", "origin_mismatch", "workspace_mismatch", "company_mismatch", "unknown_user"] as const) {
      expect(workspaceHandoffFailureStatus(reason)).toBe(401);
    }
    expect(isWorkspaceHandoffRepairReason("missing_membership")).toBe(true);
    expect(isWorkspaceHandoffRepairReason("expired")).toBe(false);
  });
});

describe("handoff URL handling", () => {
  it("reduces a landing target to a same-origin path", () => {
    expect(sanitizeWorkspaceHandoffRedirectPath("/PAP/issues/PAP-1")).toBe("/PAP/issues/PAP-1");
    expect(sanitizeWorkspaceHandoffRedirectPath("https://attacker.example.com/")).toBe("/");
    expect(sanitizeWorkspaceHandoffRedirectPath("//attacker.example.com")).toBe("/");
    expect(sanitizeWorkspaceHandoffRedirectPath("/\\attacker.example.com")).toBe("/");
    expect(sanitizeWorkspaceHandoffRedirectPath("/ok\nSet-Cookie: x=1")).toBe("/");
    expect(sanitizeWorkspaceHandoffRedirectPath(undefined)).toBe("/");
  });

  it("normalizes origins and refuses non-http schemes", () => {
    expect(normalizeWorkspaceHandoffOrigin("https://host:443/path")).toBe("https://host");
    expect(normalizeWorkspaceHandoffOrigin("http://host:42013/x")).toBe("http://host:42013");
    expect(normalizeWorkspaceHandoffOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeWorkspaceHandoffOrigin("not a url")).toBeNull();
  });

  it("builds an exchange URL on the bound origin", () => {
    const { ticket } = mintTicket();
    const url = new URL(buildWorkspaceHandoffExchangeUrl({ origin: ORIGIN, ticket }));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/api/auth/workspace-handoff/exchange");
    expect(url.searchParams.get("ticket")).toBe(ticket);
  });

  it("redacts the ticket from anything log-shaped", () => {
    const { ticket } = mintTicket();
    const line = `GET /api/auth/workspace-handoff/exchange?ticket=${ticket}&next=%2F 302`;
    const redacted = redactWorkspaceHandoffTicket(line);
    expect(redacted).not.toContain(ticket);
    expect(redacted).toContain("ticket=[redacted]");
    expect(redacted).toContain("next=%2F");
  });
});
