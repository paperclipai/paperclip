import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const resolveConnectionGrantSecret = vi.hoisted(() => vi.fn());
vi.mock("../../connection-credentials.js", () => ({ resolveConnectionGrantSecret }));

import { createManagedGoogleAccessRemoval, summarizeManagedGoogleAccess } from "./google-access-removal.js";
import type { PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { logger } from "../../../middleware/logger.js";

const companyId = "company-1";

function fakeDb(rows: { grants?: unknown[]; connections?: unknown[] } = {}) {
  const answer = (columns: Record<string, unknown>) => ("secretRefs" in columns ? rows.connections ?? []
    : "refs" in columns ? rows.grants ?? []
      : "latestVersion" in columns ? [{ latestVersion: 1 }]
        : "status" in columns ? [{ status: "revoked" }] : []);
  const db: Record<string, unknown> = {
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    select: vi.fn((columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const result = Promise.resolve(answer(columns));
          return Object.assign(result, { for: () => result });
        },
      }),
    })),
  };
  db.transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db));
  return db as unknown as Db;
}

const scope = () => ({ removingConnection: true, removeSecret: vi.fn(async () => true) });

function connection(oauth: Record<string, unknown>, authKind = "oauth") {
  return { id: "connection-1", companyId, authKind, config: { oauth } } as never;
}

const managedGoogle = { strategy: "paperclip_cloud_connector", connectorProfile: "workspace.all", connectorSubjectUserId: "org-owner" };

function grant(
  id: string,
  kind: string,
  subject: { subjectUserId?: string; subjectAgentId?: string; consentSubject?: string },
  refreshSecretId = `${id}-refresh`,
) {
  return {
    id, companyId, connectionId: "connection-1", kind,
    subjectUserId: subject.subjectUserId ?? null,
    subjectAgentId: subject.subjectAgentId ?? null,
    providerTenant: subject.consentSubject ? { externalId: subject.consentSubject } : null,
    credentialSecretRefs: [
      { configPath: "oauth.access_token", secretId: `${id}-access` },
      { configPath: "oauth.refresh_token", secretId: refreshSecretId },
    ],
  } as never;
}

type RevokeValues = Parameters<PaperclipCloudConnector["revoke"]>[0];

function connectorWith(revoke: (values: RevokeValues) => Promise<{ outcome?: string }>) {
  return { revoke: vi.fn(revoke) } as unknown as PaperclipCloudConnector & { revoke: ReturnType<typeof vi.fn> };
}

async function run(
  removal: ReturnType<typeof createManagedGoogleAccessRemoval>,
  oauth: Record<string, unknown>,
  grants: never[],
  authKind?: string,
) {
  const prepared = await removal.prepare(connection(oauth, authKind), grants, undefined, scope());
  return prepared ? prepared.send() : null;
}

describe("managed Google access removal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveConnectionGrantSecret.mockReset();
    resolveConnectionGrantSecret.mockImplementation(async (_db, _connection, _grant, ref: { secretId: string }) => ({ value: `token-for-${ref.secretId}`, latestVersion: 1 }));
  });

  it("revokes per-user, per-agent and organization grants each under the subject that consented", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("user-grant", "user", { subjectUserId: "user-1", consentSubject: "user-1" }),
      grant("agent-grant", "agent", { subjectAgentId: "agent-1", consentSubject: "agent:agent-1" }),
      grant("org-grant", "organization", { consentSubject: "first-consenter" }),
      grant("old-org-grant", "organization", {}),
    ])).resolves.toEqual({ provider: "google", result: "ended", outcomes: ["revoked", "revoked", "revoked", "revoked"] });
    expect(connector.revoke.mock.calls.map(([values]) => [values.subject, values.token, values.profile])).toEqual([
      ["user-1", "token-for-user-grant-refresh", "workspace.all"],
      ["agent:agent-1", "token-for-agent-grant-refresh", "workspace.all"],
      ["first-consenter", "token-for-org-grant-refresh", "workspace.all"],
      ["org-owner", "token-for-old-org-grant-refresh", "workspace.all"],
    ]);
  });

  it("sends a refresh token shared by two grants once", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await run(removal, managedGoogle, [
      grant("org-grant", "organization", {}, "shared-refresh"),
      grant("user-grant", "user", { subjectUserId: "org-owner" }, "shared-refresh"),
    ]);
    expect(connector.revoke).toHaveBeenCalledTimes(1);
  });

  it("sends two grants of one user one after the other and reports access ended but unconfirmed", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const outcomes = ["other_connections_remain", "revoked"];
    const connector = connectorWith(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { outcome: outcomes.shift() };
    });
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("org-grant", "organization", { consentSubject: "user-1" }),
      grant("user-grant", "user", { subjectUserId: "user-1", consentSubject: "user-1" }),
    ])).resolves.toEqual({ provider: "google", result: "ended_unconfirmed", outcomes: ["other_connections_remain", "revoked"] });
    expect(maxInFlight).toBe(1);
    expect(connector.revoke.mock.calls.map(([values]) => values.token)).toEqual([
      "token-for-org-grant-refresh", "token-for-user-grant-refresh",
    ]);
  });

  it.each([
    "binding_not_known", "provider_revocation_failed", "revocation_in_progress",
  ])("reports access not ended when one token was revoked and another reports %s", async (later) => {
    const outcomes = ["revoked", later];
    const connector = connectorWith(async () => ({ outcome: outcomes.shift() }));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("a", "user", { consentSubject: "user-1" }),
      grant("b", "organization", { consentSubject: "user-1" }),
    ])).resolves.toMatchObject({ result: "not_ended" });
  });

  it.each([
    ["a customer-owned Google client", { strategy: "authorization_code", provider: "google" }, "oauth"],
    ["a managed GitHub connection", { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" }, "oauth"],
    ["a non-OAuth connection", managedGoogle, "api_key"],
  ])("makes no broker call for %s", async (_label, oauth, authKind) => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await expect(run(removal, oauth, [grant("user-grant", "user", { subjectUserId: "user-1" })], authKind)).resolves.toBeNull();
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(resolveConnectionGrantSecret).not.toHaveBeenCalled();
  });

  it("reports access not ended when Paperclip Cloud is not configured or the token is unreadable", async () => {
    resolveConnectionGrantSecret.mockRejectedValueOnce(new Error("missing"));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => null });
    await expect(run(removal, managedGoogle, [
      grant("user-grant", "user", { subjectUserId: "user-1" }),
      grant("agent-grant", "agent", { subjectAgentId: "agent-1" }),
    ])).resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["credential_unavailable", "broker_unavailable"] });
  });

  it("reports access not ended when creating the Paperclip Cloud client throws", async () => {
    const removal = createManagedGoogleAccessRemoval(fakeDb(), {
      currentCloudConnector: () => { throw new Error("instance key is invalid"); },
    });
    await expect(run(removal, managedGoogle, [grant("user-grant", "user", { subjectUserId: "user-1" })]))
      .resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["broker_unavailable"] });
  });

  it("logs an unexpected failure without the token and reports access not ended", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    const broken = { ...(grant("user-grant", "user", { subjectUserId: "user-1" }) as object) };
    Object.defineProperty(broken, "credentialSecretRefs", { get() { throw new TypeError("token-for-user-grant-refresh"); } });
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [broken as never]))
      .resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["unexpected_error"] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("token-for-user-grant-refresh");
    expect(connector.revoke).not.toHaveBeenCalled();
  });

  it("bounds all broker calls of one removal by a single deadline", async () => {
    let clock = 0;
    const connector = connectorWith(async (values) => {
      clock += values.timeoutMs ?? 0;
      return { outcome: "other_connections_remain" };
    });
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector, timeoutMs: 5_000, now: () => clock });
    await expect(run(removal, managedGoogle, [
      grant("a", "user", { consentSubject: "user-1" }),
      grant("b", "user", { consentSubject: "user-2" }),
    ])).resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["other_connections_remain", "broker_unavailable"] });
    expect(connector.revoke).toHaveBeenCalledTimes(1);
    expect(connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
  });

  it("reports a per-agent connection whose last agent grant was revoked as ended but unconfirmed", async () => {
    const outcomes = ["other_connections_remain", "revoked"];
    const connector = connectorWith(async () => ({ outcome: outcomes.shift() }));
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("agent-a", "agent", { subjectAgentId: "a", consentSubject: "agent:a" }),
      grant("agent-b", "agent", { subjectAgentId: "b", consentSubject: "agent:b" }),
    ])).resolves.toMatchObject({ result: "ended_unconfirmed" });
  });

  it.each([
    [["revoked", "revoked"], "ended"],
    [["broker_unavailable", "revoked"], "not_ended"],
    [["other_connections_remain", "binding_not_known"], "not_ended"],
    [["revoked", "unexpected_error"], "not_ended"],
    [["other_connections_remain", "other_connections_remain"], "other_connections_remain"],
    [["other_connections_remain", "revoked"], "ended_unconfirmed"],
    [["revoked", "other_connections_remain"], "ended_unconfirmed"],
  ] as const)("summarizes %j as %s", (outcomes, result) => {
    expect(summarizeManagedGoogleAccess([...outcomes]).result).toBe(result);
  });
  it("records each result, including ended_unconfirmed, as its own audit event", async () => {
    const values = vi.fn(async () => undefined);
    const db = { ...fakeDb(), insert: vi.fn(() => ({ values })) } as unknown as Db;
    const outcomes = ["other_connections_remain", "revoked"];
    const connector = connectorWith(async () => ({ outcome: outcomes.shift() }));
    const removal = createManagedGoogleAccessRemoval(db, { currentCloudConnector: () => connector });
    const prepared = await removal.prepare(connection(managedGoogle), [
      grant("agent-a", "agent", { subjectAgentId: "a", consentSubject: "agent:a" }),
      grant("agent-b", "agent", { subjectAgentId: "b", consentSubject: "agent:b" }),
    ], undefined, { ...scope(), grantId: "agent-a" });
    await prepared!.send();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      action: "connection.google_access_removal",
      reasonCode: "ended_unconfirmed",
      details: { grantId: "agent-a", providerAccess: { provider: "google", result: "ended_unconfirmed", outcomes: ["other_connections_remain", "revoked"] } },
    }));
    expect(JSON.stringify(values.mock.calls)).not.toContain("token-for");
  });
  it("deletes each sent refresh token only after the broker answered, whatever the outcome", async () => {
    const order: string[] = [];
    const connector = connectorWith(async (values) => { order.push(`revoke:${values.token}`); return { outcome: "provider_revocation_failed" }; });
    const removal = createManagedGoogleAccessRemoval(fakeDb(), { currentCloudConnector: () => connector });
    const removeSecret = vi.fn(async (secretId: string) => { order.push(`delete:${secretId}`); });
    const prepared = await removal.prepare(connection(managedGoogle), [grant("user-grant", "user", { consentSubject: "user-1" })], undefined, { removingConnection: true, removeSecret });
    await prepared!.send();
    expect(order).toEqual(["revoke:token-for-user-grant-refresh", "delete:user-grant-refresh"]);
  });

  it("neither sends nor deletes a refresh token that a live connection or grant still uses", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const db = fakeDb({ connections: [{ id: "connection-1", refs: [], secretRefs: [{ secretId: "org-grant-refresh" }] }] });
    const removal = createManagedGoogleAccessRemoval(db, { currentCloudConnector: () => connector });
    const removeSecret = vi.fn();
    await expect(removal.prepare(connection(managedGoogle), [grant("org-grant", "organization", { consentSubject: "user-1" })], undefined, { removingConnection: false, removeSecret }))
      .resolves.toBeNull();
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(removeSecret).not.toHaveBeenCalled();
  });
});
