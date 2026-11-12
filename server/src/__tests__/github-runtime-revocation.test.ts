import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken, verifyRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({
  projectCredentials: vi.fn(async () => null as unknown),
  ordinaryCredentials: vi.fn(async () => ({ status: "available", env: { GH_TOKEN: "legacy-compatible" } })),
  captureRunIdentity: vi.fn(async (): Promise<any> => ({ run: { scopeKind: "company", issueId: null, nativeIssueId: null, contextSnapshot: {} } })),
}));
vi.mock("../services/project-run-github-access.js", () => ({ resolveBoundProjectGitHubCredentials: mocks.projectCredentials }));
vi.mock("../services/github-operation-credentials.js", () => ({ resolveGitHubOperationCredentials: mocks.ordinaryCredentials }));
vi.mock("../services/run-identity.js", () => ({ captureRunIdentity: mocks.captureRunIdentity }));
vi.mock("../services/connection-intents.js", () => ({ connectionIntentService: () => new Proxy({}, { get: () => vi.fn() }) }));

afterEach(() => {
  mocks.projectCredentials.mockClear();
  mocks.ordinaryCredentials.mockClear();
  mocks.captureRunIdentity.mockReset().mockResolvedValue({ run: { scopeKind: "company", issueId: null, nativeIssueId: null, contextSnapshot: {} } });
  vi.unstubAllEnvs();
});

function app() {
  const router = express();
  router.use(express.json());
  router.use(runtimeConnectionIntentRoutes({} as never));
  router.use(errorHandler);
  return router;
}

function token(input: { scope?: "github_credentials" | "git_credentials"; githubProjectRepositories?: string[]; allowGitHub?: boolean } = {}) {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "github-runtime-revocation-test-secret");
  const created = createRuntimeToolsToken({ companyId: "company", agentId: "agent", runId: "run", responsibleUserId: "user",
    scope: input.scope ?? "github_credentials", githubProjectRepositories: input.githubProjectRepositories,
    githubProjectBindings: input.githubProjectRepositories?.map(repositoryUrl => ({ projectId: "project", repositoryUrl })), allowGitHub: input.allowGitHub });
  if (!created) throw new Error("runtime token signing is not configured");
  return created.token;
}

function tamperPayload(signedToken: string, update: (claims: Record<string, unknown>) => void) {
  const [header, payload, signature] = signedToken.split(".");
  if (!header || !payload || !signature) throw new Error("Expected a signed runtime token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  update(claims);
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
}

describe("GitHub runtime project authorization", () => {
  it("reauthorizes signed project repositories before returning credentials and accepts legacy tokens", async () => {
    const server = app();
    const repositories = ["https://github.com/acme/project.git"];
    const projectToken = token({ githubProjectRepositories: repositories });
    const denied = await request(server).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${projectToken}`).send({});

    expect(denied.status).toBe(403);
    expect(mocks.projectCredentials).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      companyId: "company", agentId: "agent", runId: "run", bindings: repositories.map(repositoryUrl => ({ projectId: "project", repositoryUrl })),
    });
    expect(mocks.ordinaryCredentials).not.toHaveBeenCalled();

    mocks.projectCredentials.mockResolvedValueOnce({ status: "available", env: { GH_TOKEN: "revalidated" } });
    const reauthorized = await request(server).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${projectToken}`).send({});
    expect(reauthorized.status).toBe(200);
    expect(reauthorized.body).toMatchObject({ env: { GH_TOKEN: "revalidated" } });
    expect(mocks.projectCredentials).toHaveBeenCalledTimes(2);

    mocks.projectCredentials.mockClear();
    const legacy = await request(server).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${token()}`).send({});
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ status: "available", env: { GH_TOKEN: "legacy-compatible" } });
    expect(mocks.projectCredentials).not.toHaveBeenCalled();
    expect(mocks.ordinaryCredentials).toHaveBeenCalledOnce();
    expect(mocks.captureRunIdentity).toHaveBeenCalledOnce();
  });

  it("requires explicit signed GitHub permission for legacy git_credentials tokens", async () => {
    const server = app();
    const denied = await request(server).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${token({ scope: "git_credentials" })}`).send({});
    expect(denied.status).toBe(401);
    expect(mocks.projectCredentials).not.toHaveBeenCalled();
    expect(mocks.ordinaryCredentials).not.toHaveBeenCalled();

    const allowed = await request(server).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${token({ scope: "git_credentials", allowGitHub: true })}`).send({});
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ env: { GH_TOKEN: "legacy-compatible" } });
    expect(mocks.ordinaryCredentials).toHaveBeenCalledOnce();
  });

  it("rejects modified allow_github and project repository claims before credential resolution", async () => {
    const server = app();
    const authorizedToken = token({ scope: "git_credentials", allowGitHub: true,
      githubProjectRepositories: ["https://github.com/acme/project.git"] });
    const tampered = tamperPayload(authorizedToken, claims => {
      claims.allow_github = false;
      claims.github_project_repositories = ["https://github.com/attacker/other.git"];
      claims.github_project_bindings = [{ projectId: "other", repositoryUrl: "https://github.com/attacker/other.git" }];
    });

    const response = await request(server).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${tampered}`).send({});

    expect(response.status).toBe(401);
    expect(mocks.projectCredentials).not.toHaveBeenCalled();
    expect(mocks.ordinaryCredentials).not.toHaveBeenCalled();
  });

  it.each([
    { label: "task", run: { scopeKind: "task", issueId: "issue", nativeIssueId: null, contextSnapshot: { issueId: "issue" } } },
    { label: "project", run: { scopeKind: "company", issueId: null, nativeIssueId: null, contextSnapshot: { projectId: "project" } } },
  ])("rejects a legacy company token when the run has $label context", async ({ run }) => {
    mocks.captureRunIdentity.mockResolvedValueOnce({ run });
    const response = await request(app()).post("/runtime-tools/github/credentials")
      .set("Authorization", `Bearer ${token()}`).send({});

    expect(response.status).toBe(403);
    expect(mocks.captureRunIdentity).toHaveBeenCalledOnce();
    expect(mocks.ordinaryCredentials).not.toHaveBeenCalled();
    expect(mocks.projectCredentials).not.toHaveBeenCalled();
  });

  it("round-trips signed Azure project repositories and rejects claim tampering", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "github-runtime-revocation-test-secret");
    const repositories = [{ projectId: "project-id", repositoryUrl: "https://dev.azure.com/org/project/_git/repo" }];
    const created = createRuntimeToolsToken({ companyId: "company", agentId: "agent", runId: "run", responsibleUserId: "user",
      scope: "git_credentials", azureProjectRepositories: repositories });
    if (!created) throw new Error("runtime token signing is not configured");

    expect(verifyRuntimeToolsToken(created.token, "git_credentials")?.azure_project_repositories).toEqual(repositories);
    const tampered = tamperPayload(created.token, claims => {
      claims.azure_project_repositories = [{ projectId: "other-project", repositoryUrl: "https://dev.azure.com/other/project/_git/repo" }];
    });
    expect(verifyRuntimeToolsToken(tampered, "git_credentials")).toBeNull();
  });

  it("rejects malformed or oversized signed Azure repository claim shapes", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "github-runtime-revocation-test-secret");
    const issueToken = (azureProjectRepositories: unknown[]) => createRuntimeToolsToken({ companyId: "company", agentId: "agent", runId: "run", responsibleUserId: "user",
      scope: "git_credentials", azureProjectRepositories: azureProjectRepositories as Array<{ projectId: string; repositoryUrl: string }> })!.token;

    const many = Array.from({ length: 101 }, (_, index) => ({ projectId: String(index), repositoryUrl: `https://dev.azure.com/org/project/_git/repo-${index}` }));
    const largeToken = issueToken(many);
    expect(largeToken.length).toBeLessThan(12_000);
    expect(verifyRuntimeToolsToken(largeToken, "git_credentials")?.azure_project_repositories).toEqual(many);
    const parts = largeToken.split(".");
    expect(verifyRuntimeToolsToken(`${parts[0]}.${parts[1]}.${parts[2]}x`, "git_credentials")).toBeNull();
    expect(() => issueToken(Array.from({ length: 1001 }, (_, index) => ({ projectId: String(index), repositoryUrl: "https://dev.azure.com/org/project/_git/repo" })))).toThrow(/too many/i);
    expect(verifyRuntimeToolsToken(issueToken([{ projectId: "project", repositoryUrl: "x".repeat(2049) }]), "git_credentials")).toBeNull();
    expect(verifyRuntimeToolsToken(issueToken([{ projectId: 42, repositoryUrl: "https://dev.azure.com/org/project/_git/repo" }]), "git_credentials")).toBeNull();
  });
});
