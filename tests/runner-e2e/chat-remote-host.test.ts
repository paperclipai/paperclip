import { CHAT_SETUP_HEALTH_ID, CHAT_SETUP_HEALTH_SUITE } from "./chat-setup-health.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MatrixExecution } from "./types.js";
import { prepareChatRemoteHost, selectsRemoteChat } from "./chat-remote-host.js";
import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(lifecycle = "spot") {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-host-offline-")); roots.push(root);
  const execution = { id: "chat-features.runner-opencode.local.create-backlog", suite: { id: "chat-features" }, profile: { id: "runner-opencode", provider: "opencode", model: CHAT_OPENCODE_MODEL, adapterType: "paperclip_runner", credential: "OPENROUTER_API_KEY" }, environment: { id: "local" }, task: { automaticRetryPolicy: "single_attempt" } } as unknown as MatrixExecution;
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master", GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "a".repeat(40), OPENROUTER_API_KEY: "synthetic-private-canary" };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/api/token")) return new Response("synthetic-imds-token");
    if (u.endsWith("/instance-life-cycle")) return new Response(lifecycle);
    return Response.json({ instanceId: "i-1234567890abcdef0", imageId: "ami-1234567890abcdef0", region: "us-east-1", architecture: "x86_64", privateIp: "not-retained" });
  });
  return { executions: [execution], env, repositoryRoot: root, outputDirectory: root, dependencies: { fetch: fetch as typeof globalThis.fetch, platform: "linux", arch: "x64", sourceRevision: async () => "a".repeat(40) }, fetch,
    receipt: async () => JSON.parse(await readFile(path.join(root, "chat-remote-host.json"), "utf8")) };
}
describe("remote-only chat host qualification without native/provider calls", () => {
  it.each(["projects.project-work", "projects.project-defaults", "instance-operations.restart-service"])("admits only the bound TestOps pilot cell %s on the actual AWS host", async scenario => {
    const f = await fixture();
    f.env.GITHUB_WORKFLOW_REF = "paperclipai/paperclip/.github/workflows/chat-completion-testops.yml@refs/heads/master";
    Object.assign(f.env, { PAPERCLIP_CHAT_COMPLETION_TESTOPS: "v1", ALLURE_JOB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1" });
    f.executions[0]!.id = `chat-features.runner-opencode.local.${scenario}`;
    expect(await prepareChatRemoteHost(f)).toMatchObject({ databaseLane: "embedded-postgres", maxAutomaticRetries: 0 });
    expect(await f.receipt()).toMatchObject({ workflowRef: f.env.GITHUB_WORKFLOW_REF, evaluationAdmitted: false });
  });
  it.each(["foreign-cell", "missing-admission", "missing-jobrun", "replay", "candidate-workflow"])("rejects TestOps %s before AWS metadata or inference", async kind => {
    const f = await fixture();
    f.env.GITHUB_WORKFLOW_REF = "paperclipai/paperclip/.github/workflows/chat-completion-testops.yml@refs/heads/master";
    const extra = { PAPERCLIP_CHAT_COMPLETION_TESTOPS: "v1", ALLURE_JOB_RUN_ID: "77" };
    Object.assign(f.env, extra); f.executions[0]!.id = "chat-features.runner-opencode.local.projects.project-work";
    if (kind === "foreign-cell") f.executions[0]!.id = "chat-features.runner-opencode.local.tasks.delete";
    if (kind === "missing-admission") Object.assign(f.env, { PAPERCLIP_CHAT_COMPLETION_TESTOPS: undefined });
    if (kind === "missing-jobrun") Object.assign(f.env, { ALLURE_JOB_RUN_ID: undefined });
    if (kind === "replay") f.env.GITHUB_RUN_ATTEMPT = "2";
    if (kind === "candidate-workflow") f.env.GITHUB_WORKFLOW_REF = f.env.GITHUB_WORKFLOW_REF.replace("refs/heads/master", "refs/heads/candidate");
    await expect(prepareChatRemoteHost(f)).rejects.toThrow("trusted-github-linux-source-required");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("requires real Spot metadata and retains only closed source-bound host proof", async () => {
    const f = await fixture(); const policy = await prepareChatRemoteHost(f); const receipt = await f.receipt();
    expect(policy).toMatchObject({ databaseLane: "embedded-postgres", maxAutomaticRetries: 0, maxParallel: 2 });
    expect(receipt).toMatchObject({ status: "qualified-host-only", spotVerified: true, evaluationAdmitted: false, allocationSpotOnlyClaimed: false, sourceRevision: "a".repeat(40) });
    expect(JSON.stringify(receipt)).not.toMatch(/synthetic-private-canary|synthetic-imds-token|privateIp|not-retained/);
    expect(f.fetch.mock.calls.every(([url]) => String(url).startsWith("http://169.254.169.254/latest/"))).toBe(true);
    expect(receipt.databaseLane).toBe("embedded-postgres");
    expect(receipt).not.toHaveProperty("postgres");
    expect(receipt).not.toHaveProperty("dockerEngineSha256");
  });
  it("accepts the user-authorized fleet fallback while truthfully recording On-Demand", async () => {
    const f = await fixture("on-demand"); await prepareChatRemoteHost(f);
    expect(await f.receipt()).toMatchObject({ lifecycle: "on-demand", status: "qualified-host-only", spotVerified: false, hostPolicy: "aws-fleet-spot-or-on-demand", evaluationAdmitted: false });
  });
  it.each(["", "unknown", "preemptible"])("refuses unproven host lifecycle %s", async lifecycle => {
    const f = await fixture(lifecycle); await expect(prepareChatRemoteHost(f)).rejects.toThrow("unknown-host-lifecycle-refused");
    expect(await f.receipt()).toMatchObject({ lifecycle, status: "blocked", evaluationAdmitted: false });
  });
  it.each(["local", "branch-workflow", "wrong-source", "wrong-model", "automatic-retry", "foreign-repository"])("fails closed on %s before metadata", async kind => {
    const f = await fixture();
    if (kind === "local") f.dependencies.platform = "darwin";
    if (kind === "branch-workflow") f.env.GITHUB_WORKFLOW_REF = "untrusted@refs/heads/branch";
    if (kind === "wrong-source") f.env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA = "b".repeat(40);
    if (kind === "wrong-model") f.executions[0]!.profile.model = "other";
    if (kind === "automatic-retry") f.executions[0]!.task.automaticRetryPolicy = undefined;
    if (kind === "foreign-repository") f.env.GITHUB_REPOSITORY = "foreign/repository";
    await expect(prepareChatRemoteHost(f)).rejects.toThrow("trusted-github-linux-source-required"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("records missing actual AWS identity without admitting an evaluation", async () => {
    const f = await fixture(); f.dependencies.fetch = vi.fn(async () => new Response("", { status: 403 }));
    await expect(prepareChatRemoteHost(f)).rejects.toThrow("aws-instance-identity-unavailable");
    expect(await f.receipt()).toMatchObject({ status: "blocked", evaluationAdmitted: false, databaseLane: "embedded-postgres" });
  });
  it.each(["architecture", "region", "instanceId"])("rejects wrong AWS %s", async field => {
    const f = await fixture(), original = f.dependencies.fetch;
    f.dependencies.fetch = vi.fn(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).endsWith("/document")) return response;
      const identity = await response.json(); identity[field] = "wrong"; return Response.json(identity);
    });
    await expect(prepareChatRemoteHost(f)).rejects.toThrow("aws-instance-identity-unavailable");
  });
  it("keeps the one exact health cell on the same AWS/ordinary embedded database policy", async () => {
    const f = await fixture("on-demand"); f.executions[0]!.id = CHAT_SETUP_HEALTH_ID; f.executions[0]!.suite.id = CHAT_SETUP_HEALTH_SUITE;
    expect(selectsRemoteChat(f.executions)).toBe(true);
    expect(await prepareChatRemoteHost(f)).toMatchObject({ databaseLane: "embedded-postgres", maxAutomaticRetries: 0, maxParallel: 2 });
    expect(await f.receipt()).not.toHaveProperty("dockerEngineSha256");
    f.executions[0]!.id = "chat-setup-health.runner-opencode.local.wrong";
    expect(selectsRemoteChat(f.executions)).toBe(false);
  });
  it("does not change historical/other profiles or require IMDS for their discovery", async () => {
    const f = await fixture(); f.executions[0]!.profile.id = "runner-codex-subscription";
    expect(selectsRemoteChat(f.executions)).toBe(false); expect(await prepareChatRemoteHost(f)).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled();
  });
});
