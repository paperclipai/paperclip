import { describe, expect, it, vi } from "vitest";
import { connectionGrants, toolConnections, toolConnectionInstalls, type Db } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({
  secret: vi.fn(async () => ({ value: "private PEM", latestVersion: 1 })),
  acquire: vi.fn(async () => ({ token: "short-lived-token", github: { userId: "123", login: "app[bot]" } })),
}));
vi.mock("./connection-credentials.js", () => ({ resolveConnectionGrantSecret: mocks.secret }));
vi.mock("./github-app-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("./github-app-client.js")>(),
  createGitHubAppClient: () => ({ acquire: mocks.acquire }),
}));
import { resolveGitHubAppCredential } from "./github-app-credentials.js";
import { githubAppFailure } from "./github-app-client.js";

function fixture() {
  const connection = { id: "connection", companyId: "company", status: "active", enabled: true, credentialPolicy: "per_agent",
    config: { sourceTemplateKey: "github", connectionMethodKey: "app-installation", methodConfig: {
      appId: "1", installationId: "2", repositories: "owner/repo", permissionProfile: "read",
    } } } as unknown as typeof toolConnections.$inferSelect;
  const grant = { id: "grant", companyId: "company", connectionId: "connection", kind: "agent", subjectAgentId: "agent", status: "active",
    credentialSecretRefs: [{ configPath: "credentials.privateKey", secretId: "secret" }] } as typeof connectionGrants.$inferSelect;
  const rows = { connection: structuredClone(connection), grant: structuredClone(grant), installs: [{ targetType: "agent", targetId: "agent" }] };
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => {
    if (table === toolConnections) return [rows.connection];
    if (table === connectionGrants) return [rows.grant];
    if (table === toolConnectionInstalls) return rows.installs;
    throw new Error("Unexpected table");
  } }) }) } as unknown as Db;
  mocks.secret.mockClear();
  mocks.acquire.mockClear();
  return { connection, grant, rows, db };
}

describe("GitHub App credential authorization", () => {
  it.each(["user", "organization"] as const)("supports selected and all-agent installs for %s ownership", async kind => {
    const { connection, grant, rows, db } = fixture();
    connection.credentialPolicy = kind === "user" ? "per_user" : "shared";
    grant.kind = kind;
    grant.subjectAgentId = null;
    grant.subjectUserId = kind === "user" ? "owner" : null;
    rows.connection = structuredClone(connection);
    rows.grant = structuredClone(grant);
    rows.installs = [{ targetType: "agent", targetId: "agent-a" }, { targetType: "agent", targetId: "agent-b" }];
    for (const agentId of ["agent-a", "agent-b"]) {
      await expect(resolveGitHubAppCredential(db, connection, grant, false, false, agentId)).resolves.toMatchObject({ token: "short-lived-token" });
    }
    await expect(resolveGitHubAppCredential(db, connection, grant, false, false, "other-agent")).rejects.toThrow();
    rows.installs = [{ targetType: "company", targetId: "company" }];
    await expect(resolveGitHubAppCredential(db, connection, grant, false, false, "new-agent")).resolves.toMatchObject({ token: "short-lived-token" });
  });

  it.each(["owner", "policy", "kind", "install"])("rechecks %s during shared/personal acquisition", async change => {
    const { connection, grant, rows, db } = fixture();
    connection.credentialPolicy = "per_user";
    grant.kind = "user";
    grant.subjectAgentId = null;
    grant.subjectUserId = "owner";
    rows.connection = structuredClone(connection);
    rows.grant = structuredClone(grant);
    mocks.acquire.mockImplementationOnce(async () => {
      if (change === "owner") rows.grant.subjectUserId = "another-owner";
      if (change === "policy") rows.connection.credentialPolicy = "shared";
      if (change === "kind") rows.grant.kind = "organization";
      if (change === "install") rows.installs = [];
      return { token: "short-lived-token", github: { userId: "123", login: "app[bot]" } };
    });
    await expect(resolveGitHubAppCredential(db, connection, grant, false, false, "agent")).rejects.toThrow();
  });

  it("preserves safe provider diagnostics through vault-backed acquisition", async () => {
    const { connection, grant, db } = fixture();
    mocks.acquire.mockImplementationOnce(async () => githubAppFailure("permissions"));
    await expect(resolveGitHubAppCredential(db, connection, grant)).rejects.toMatchObject({
      details: { code: "github_app_access_unavailable", reason: "permissions" },
    });
  });

  it("binds the private-key read and cache namespace to the exact selected grant", async () => {
    const { connection, grant, db } = fixture();
    expect(await resolveGitHubAppCredential(db, connection, grant)).toMatchObject({ token: "short-lived-token" });
    expect(mocks.secret).toHaveBeenCalledWith(db, connection, grant, grant.credentialSecretRefs[0], expect.any(Object));
    expect(mocks.acquire).toHaveBeenCalledWith("company:connection:grant:1", expect.objectContaining({ repositories: ["owner/repo"] }), "private PEM", false);
  });

  it.each(["disabled", "revoked", "reassigned", "uninstalled", "changed scope", "changed secret"])("denies %s before reading the vault", async change => {
    const { connection, grant, db, rows } = fixture();
    if (change === "disabled") rows.connection.enabled = false;
    if (change === "revoked") rows.grant.status = "revoked";
    if (change === "reassigned") rows.grant.subjectAgentId = "other-agent";
    if (change === "uninstalled") rows.installs = [];
    if (change === "changed scope") rows.connection.config.methodConfig = { repositories: "owner/other" };
    if (change === "changed secret") rows.grant.credentialSecretRefs = [{ configPath: "credentials.privateKey", secretId: "other" }];
    await expect(resolveGitHubAppCredential(db, connection, grant)).rejects.toThrow();
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("rechecks revocation after network acquisition before returning a token", async () => {
    const { connection, grant, db, rows } = fixture();
    mocks.acquire.mockImplementationOnce(async () => {
      rows.grant.status = "revoked";
      return { token: "short-lived-token", github: { userId: "123", login: "app[bot]" } };
    });
    await expect(resolveGitHubAppCredential(db, connection, grant)).rejects.toThrow();
  });
  it("cannot use a draft setup bypass after the connection is disabled", async () => {
    const { connection, grant, db, rows } = fixture();
    connection.status = "draft";
    rows.connection.status = "disabled";
    await expect(resolveGitHubAppCredential(db, connection, grant, true)).rejects.toThrow();
    expect(mocks.secret).not.toHaveBeenCalled();
  });

});
