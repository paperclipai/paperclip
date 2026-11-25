import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeGitHubAccess, type NativeGitHubAccess } from "./native-github-access.js";

const scope = { companyId: "company-a", agentId: "agent-a", issueId: "task-a" };
const binding = (runId: string) => ({ ...scope, runId });
const repositoryUrl = "https://dev.azure.com/contoso/Platform/_git/paperclip";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function broker(resolveGitCredentials: (run: ReturnType<typeof binding>, remote: string) => Promise<unknown> = async run => ({
  status: "available", env: { PAPERCLIP_AZURE_GIT_TOKEN: `fixture-${run.runId}` },
}), onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined)) {
  const root = await mkdtemp(path.join(tmpdir(), "native-git-access-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const resolver = vi.fn(resolveGitCredentials);
  const access = await createNativeGitHubAccess({
    scope,
    target: null,
    cwd: root,
    env: { PATH: process.env.PATH },
    resolveCredentials: vi.fn(async () => ({ status: "unavailable", env: {} })),
    resolveGitCredentials: resolver,
    onLog,
  });
  cleanups.push(access.stop);
  return { access, resolver, onLog };
}

function post(access: NativeGitHubAccess, body: unknown = { repositoryUrl }, extra: RequestInit = {}, endpoint = "/runtime-tools/git/credentials") {
  return fetch(`${access.env.PAPERCLIP_GITHUB_BROKER_URL}${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${access.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...extra,
  });
}

it("passes the exact Azure DevOps remote with the active run binding", async () => {
  const resolver = vi.fn(async (run: ReturnType<typeof binding>, remote: string) => ({
    status: "available", env: { PAPERCLIP_AZURE_GIT_TOKEN: `credential-${run.runId}`, PAPERCLIP_REPOSITORY_URL: remote },
  }));
  const { access } = await broker(resolver);
  const release = access.activate(binding("run-live"));
  const response = await post(access, { repositoryUrl });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    status: "available",
    env: { PAPERCLIP_AZURE_GIT_TOKEN: "credential-run-live", PAPERCLIP_REPOSITORY_URL: repositoryUrl },
  });
  expect(resolver).toHaveBeenCalledExactlyOnceWith(binding("run-live"), repositoryUrl);
  release();
});

it("rejects requests without an active run and after stopping the broker", async () => {
  const { access, resolver } = await broker();
  expect((await post(access)).status).toBe(403);
  expect(resolver).not.toHaveBeenCalled();
  const release = access.activate(binding("run-live"));
  expect((await post(access)).status).toBe(200);
  release();
  expect((await post(access)).status).toBe(403);
  expect(resolver).toHaveBeenCalledOnce();
  await access.stop();
  await expect(post(access)).rejects.toThrow();
  expect(() => access.activate(binding("run-after-stop"))).toThrow(/closed/);
});

it("rejects cross-binding activation and run identity supplied in the request", async () => {
  const { access, resolver } = await broker();
  for (const field of ["companyId", "agentId", "issueId"] as const) {
    expect(() => access.activate({ ...binding("run-live"), [field]: "foreign-binding" })).toThrow(/scope mismatch/);
  }
  const release = access.activate(binding("run-live"));
  const response = await post(access, { repositoryUrl, runId: "forged-run", responsibleUserId: "foreign-user" });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("forged-run");
  expect(resolver).not.toHaveBeenCalled();
  release();
});

it("validates method, route, body shape and repository URL length before resolving", async () => {
  const { access, resolver } = await broker();
  const release = access.activate(binding("run-live"));
  expect((await post(access, { repositoryUrl: "x".repeat(2049) })).status).toBe(503);
  expect((await post(access, {})).status).toBe(503);
  expect((await post(access, { repositoryUrl, token: "credential-canary" })).status).toBe(503);
  expect((await post(access, { repositoryUrl }, { method: "GET", body: undefined })).status).toBe(404);
  expect((await post(access, { repositoryUrl }, {}, "/wrong")).status).toBe(404);
  expect(resolver).not.toHaveBeenCalled();
  release();
});

it("does not expose or log provider errors or credentials", async () => {
  const providerError = "provider-failure-secret-canary";
  const credential = "azure-pat-secret-canary";
  const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined);
  const { access, onLog: log } = await broker(async () => { throw new Error(`${providerError}; ${credential}`); }, onLog);
  const release = access.activate(binding("run-live"));
  const response = await post(access);
  expect(response.status).toBe(503);
  const responseText = await response.text();
  expect(responseText).not.toContain(providerError);
  expect(responseText).not.toContain(credential);
  expect(JSON.stringify(log.mock.calls)).not.toContain(providerError);
  expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
  release();
});
