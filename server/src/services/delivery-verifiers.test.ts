import { describe, expect, it, vi } from "vitest";
import type { ExternalOperationV1 } from "@paperclipai/shared";
import { createCloudflarePagesVerifier, createGithubActionsVerifier } from "./delivery-verifiers.js";

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_BLOB_SHA = "1111111111111111111111111111111111111111";
const WORKFLOW_EVENT = "push";

function operation(overrides: Partial<ExternalOperationV1> = {}): ExternalOperationV1 {
  const now = new Date("2026-07-17T00:00:00.000Z");
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    issueId: "33333333-3333-4333-8333-333333333333",
    kind: "github_actions_workflow_run",
    provider: "github",
    stage: "ci",
    externalId: "29504462944",
    supersedesOperationId: null,
    candidateSha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
    environment: "production",
    url: null,
    state: "unknown",
    verificationStatus: "unverified",
    credentialSecretId: null,
    nextCheckAt: null,
    timeoutAt: null,
    terminalAt: null,
    lastVerifiedAt: null,
    lastVerificationError: null,
    metadata: {
      owner: "paperclipai",
      repo: "paperclip",
      githubWorkflowPath: WORKFLOW_PATH,
      githubWorkflowBlobSha: WORKFLOW_BLOB_SHA,
      githubWorkflowEvent: WORKFLOW_EVENT,
    },
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("delivery provider verifiers", () => {
  it("maps a successful GitHub Actions run to provider-backed delivery truth", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("/contents/")
        ? { type: "file", path: WORKFLOW_PATH, sha: WORKFLOW_BLOB_SHA }
        : {
            id: 29504462944,
            status: "completed",
            conclusion: "success",
            head_sha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
            path: `${WORKFLOW_PATH}@refs/heads/feature/ci-hardening`,
            event: WORKFLOW_EVENT,
            html_url: "https://github.com/paperclipai/paperclip/actions/runs/29504462944",
            created_at: "2026-07-16T14:00:00.000Z",
            updated_at: "2026-07-16T14:03:22.000Z",
            workflow_id: 42,
            run_number: 7,
            run_attempt: 1,
            repository: { full_name: "paperclipai/paperclip" },
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await createGithubActionsVerifier(fetchImpl as typeof fetch).verify({
      operation: operation(),
      credential: "secret-token",
    });

    expect(result).toMatchObject({
      operationState: "succeeded",
      eventState: "succeeded",
      candidateSha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
      environment: null,
      provider: "github",
      metadata: {
        repositoryFullName: "paperclipai/paperclip",
        workflowId: 42,
        workflowPath: WORKFLOW_PATH,
        workflowRawPath: `${WORKFLOW_PATH}@refs/heads/feature/ci-hardening`,
        workflowRef: "refs/heads/feature/ci-hardening",
        workflowBlobSha: WORKFLOW_BLOB_SHA,
        workflowEvent: WORKFLOW_EVENT,
        workflowBlobHeadSha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/actions/runs/29504462944"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-token" }) }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/contents/${WORKFLOW_PATH}?ref=5fa761a27c7d8cfc285057e6997b04b9831a07c4`),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-token" }) }),
    );
  });

  it.each([
    {
      name: "workflow path",
      run: { path: ".github/workflows/docs.yml@refs/heads/feature/ci-hardening", event: WORKFLOW_EVENT },
      contentsSha: WORKFLOW_BLOB_SHA,
      message: /workflow path does not match/,
    },
    {
      name: "workflow event",
      run: { path: `${WORKFLOW_PATH}@refs/heads/feature/ci-hardening`, event: "workflow_dispatch" },
      contentsSha: WORKFLOW_BLOB_SHA,
      message: /event does not match/,
    },
    {
      name: "workflow blob",
      run: { path: `${WORKFLOW_PATH}@refs/heads/feature/ci-hardening`, event: WORKFLOW_EVENT },
      contentsSha: "2222222222222222222222222222222222222222",
      message: /workflow blob does not match/,
    },
  ])("rejects a successful run with the wrong $name attestation", async ({ run, contentsSha, message }) => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("/contents/")
        ? { type: "file", path: WORKFLOW_PATH, sha: contentsSha }
        : {
            id: 29504462944,
            status: "completed",
            conclusion: "success",
            head_sha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
            html_url: "https://github.com/paperclipai/paperclip/actions/runs/29504462944",
            created_at: "2026-07-16T14:00:00.000Z",
            updated_at: "2026-07-16T14:03:22.000Z",
            workflow_id: 42,
            repository: { full_name: "paperclipai/paperclip" },
            ...run,
          }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(createGithubActionsVerifier(fetchImpl as typeof fetch).verify({
      operation: operation(),
      credential: "secret-token",
    })).rejects.toThrow(message);
  });

  it("rejects provider payloads that omit their own observation timestamp", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 29504462944,
      status: "completed",
      conclusion: "success",
      head_sha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
      path: `${WORKFLOW_PATH}@refs/heads/feature/ci-hardening`,
      event: WORKFLOW_EVENT,
      html_url: "https://github.com/paperclipai/paperclip/actions/runs/29504462944",
      repository: { full_name: "paperclipai/paperclip" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(createGithubActionsVerifier(fetchImpl as typeof fetch).verify({
      operation: operation(),
      credential: "secret-token",
    })).rejects.toThrow(/missing a provider observation timestamp/);
  });

  it("extracts Cloudflare Pages deployment identity and commit provenance", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        id: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
        short_id: "2268dd54",
        environment: "production",
        url: "https://example.pages.dev",
        created_on: "2026-07-16T14:00:00.000Z",
        modified_on: "2026-07-16T14:04:00.000Z",
        latest_stage: { name: "deploy", status: "success" },
        deployment_trigger: { metadata: { commit_hash: "5fa761a27c7d8cfc285057e6997b04b9831a07c4" } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const cloudflareOperation = operation({
      kind: "cloudflare_pages_deployment",
      provider: "cloudflare",
      stage: "deployment",
      externalId: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
      metadata: {
        cloudflareAccountId: "account-1",
        cloudflareProjectName: "paperclip",
      },
    });
    const result = await createCloudflarePagesVerifier(fetchImpl as typeof fetch).verify({
      operation: cloudflareOperation,
      credential: "cloudflare-token",
    });

    expect(result).toMatchObject({
      operationState: "succeeded",
      eventState: "succeeded",
      candidateSha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
      environment: "production",
      provider: "cloudflare",
    });
  });

  it("does not reuse a caller-expected Cloudflare environment as provider observation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        id: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
        created_on: "2026-07-17T00:00:30.000Z",
        modified_on: "2026-07-17T00:01:00.000Z",
        latest_stage: { name: "deploy", status: "building" },
        deployment_trigger: { metadata: { commit_hash: "5fa761a27c7d8cfc285057e6997b04b9831a07c4" } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createCloudflarePagesVerifier(fetchImpl as typeof fetch).verify({
      operation: operation({
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
        environment: "production",
        metadata: {
          cloudflareAccountId: "account-1",
          cloudflareProjectName: "paperclip",
        },
      }),
      credential: "cloudflare-token",
    });

    expect(result).toMatchObject({ operationState: "running", eventState: "pending", environment: null });
  });
});
