import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/error-handler.js";

const resolveGitCredentials = vi.hoisted(() => vi.fn(async () => ({ env: { PAPERCLIP_AZURE_GIT_TOKEN: "azure-test-token" } })));
vi.mock("../services/azure-devops-run-git-credentials.js", () => ({ resolveAzureDevOpsRunGitCredentials: resolveGitCredentials }));
vi.mock("../services/connection-intents.js", () => ({ connectionIntentService: () => new Proxy({}, { get: () => vi.fn() }) }));

afterEach(() => {
  resolveGitCredentials.mockClear();
  vi.unstubAllEnvs();
});

function app() {
  const server = express();
  server.use(express.json());
  server.use(runtimeConnectionIntentRoutes({} as never));
  server.use(errorHandler);
  return server;
}

function token(azureProjectRepositories: Array<{ projectId: string; repositoryUrl: string }>) {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "azure-project-binding-test-secret");
  const created = createRuntimeToolsToken({ companyId: "company", agentId: "agent", runId: "run", responsibleUserId: "user",
    scope: "git_credentials", azureProjectRepositories });
  if (!created) throw new Error("runtime token signing is not configured");
  return created.token;
}

function tamperAzureProjectId(signedToken: string) {
  const [header, encodedClaims, signature] = signedToken.split(".");
  if (!header || !encodedClaims || !signature) throw new Error("Expected a signed runtime token");
  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as Record<string, any>;
  claims.azure_project_repositories[0].projectId = "attacker-project";
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
}

describe("Azure Git runtime project binding", () => {
  const repositoryUrl = "https://dev.azure.com/contoso/Project/_git/repository";

  it("takes projectId from the signed claim for the requested repository URL", async () => {
    const signed = token([{ projectId: "trusted-project-id", repositoryUrl }]);
    const response = await request(app()).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${signed}`).send({ repositoryUrl });

    expect(response.status).toBe(200);
    expect(resolveGitCredentials).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      companyId: "company", agentId: "agent", runId: "run", repoUrl: repositoryUrl, projectId: "trusted-project-id",
    });
  });

  it("blocks Azure URLs when project-bound claims explicitly contain no repositories", async () => {
    const signed = token([]);
    const response = await request(app()).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${signed}`).send({ repositoryUrl });

    expect(response.status).toBe(403);
    expect(resolveGitCredentials).not.toHaveBeenCalled();
  });

  it("rejects a URL bound to multiple projects and rejects projectId from the request body", async () => {
    const ambiguous = token([
      { projectId: "project-one", repositoryUrl },
      { projectId: "project-two", repositoryUrl },
    ]);
    const ambiguousResponse = await request(app()).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${ambiguous}`).send({ repositoryUrl });
    expect(ambiguousResponse.status).toBe(403);
    expect(resolveGitCredentials).not.toHaveBeenCalled();

    const signed = token([{ projectId: "trusted-project-id", repositoryUrl }]);
    const unknownRepository = await request(app()).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${signed}`).send({ repositoryUrl: "https://dev.azure.com/contoso/Other/_git/not-bound" });
    expect(unknownRepository.status).toBe(403);
    expect(resolveGitCredentials).not.toHaveBeenCalled();

    const forgedBody = await request(app()).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${signed}`).send({ repositoryUrl, projectId: "attacker-project" });
    expect(forgedBody.status).toBe(403);
    expect(resolveGitCredentials).not.toHaveBeenCalled();
  });

  it("rejects a tampered project ID claim before calling the credential resolver", async () => {
    const signed = token([{ projectId: "trusted-project-id", repositoryUrl }]);
    const response = await request(app()).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${tamperAzureProjectId(signed)}`).send({ repositoryUrl });

    expect(response.status).toBe(401);
    expect(resolveGitCredentials).not.toHaveBeenCalled();
  });
});
