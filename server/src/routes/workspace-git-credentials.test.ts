import { describe, it, expect, vi } from "vitest";
import {
  createWorkspaceGitCredentialsRoute,
  type WorkspaceGitCredentialsDeps,
} from "./workspace-git-credentials.js";

function deps(overrides?: Partial<WorkspaceGitCredentialsDeps>): WorkspaceGitCredentialsDeps {
  return {
    runJwt: {
      verify: vi.fn(() => ({
        ok: true as const,
        claims: { runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", exp: 9_999_999_999 },
      })),
      mint: vi.fn(),
    },
    issueGitCredentials: vi.fn(async () => ({
      ok: true as const,
      username: "x-access-token",
      password: "ghs_test",
      expiresAt: "2026-06-01T00:00:00Z",
    })),
    ...overrides,
  };
}

describe("POST /api/workspace/git-credentials", () => {
  it("returns username/password for an authorized run", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps());
    const res = await handler({
      headers: { authorization: "Bearer fake.jwt" },
      body: { repoUrl: "https://github.com/acme/repo.git" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: "x-access-token", password: "ghs_test" });
  });

  it("returns 503 when issuer is not configured", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps({
      issueGitCredentials: async () => ({ ok: false as const, reason: "not_configured" as const }),
    }));
    const res = await handler({
      headers: { authorization: "Bearer fake.jwt" },
      body: { repoUrl: "https://github.com/acme/repo.git" },
    });
    expect(res.status).toBe(503);
  });

  it("rejects 401 without a JWT", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps());
    const res = await handler({ headers: {}, body: { repoUrl: "x" } });
    expect(res.status).toBe(401);
  });

  it("rejects 400 missing repoUrl", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps());
    const res = await handler({ headers: { authorization: "Bearer fake.jwt" }, body: {} });
    expect(res.status).toBe(400);
  });
});
