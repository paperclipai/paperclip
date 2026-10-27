import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../errors.js";
import { redactEventPayload } from "../../../redaction.js";
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";
import { isCurrentVercelCatalogEntry, isVercelConnection, VERCEL_API_URL, VERCEL_METHOD, VERCEL_TOOLS, vercelClient, vercelRisk, type VercelRequest } from "./index.js";

const token = "fixture-vercel-private-token";
const headers = { Authorization: `Bearer ${token}` };
const teamId = "team_fixture123";
const project = { id: "prj_fixture123", name: "fixture", accountId: teamId, framework: null, nodeVersion: "22.x" };
const deployment = { id: "dpl_fixture123", projectId: project.id, url: "fixture.vercel.app", readyState: "READY", target: null };
const deploymentArgs = { projectId: project.id, name: "fixture", files: [{ file: "index.html", content: "<h1>Preview</h1>" }] };
const previousDeployment = { uid: "dpl_previous123", projectId: project.id, state: "READY" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function fixture(respond: (url: URL, init: RequestInit) => Response | Promise<Response> = () => json({})) {
  const request = vi.fn<VercelRequest>(async (url, init) => {
    const parsed = new URL(url);
    if (init.method === "GET" && parsed.pathname === `/v9/projects/${project.id}`) return json(project);
    if (init.method === "GET" && parsed.pathname === `/v13/deployments/${deployment.id}`) return json(deployment);
    return respond(parsed, init);
  });
  return { request, client: vercelClient(headers, request, teamId) };
}
function previewFixture(existing: unknown, created: unknown = deployment) {
  return fixture((url, init) => {
    if (url.pathname === "/v7/deployments" && init.method === "GET") return json(existing);
    if (url.pathname === "/v13/deployments" && init.method === "POST") return json(created);
    throw new Error(`Unexpected fixture request: ${init.method} ${url.pathname}`);
  });
}

describe("Vercel deployment connector", () => {
  it("admits only the exact reviewed connection and catalog contract", () => {
    const config = { sourceTemplateKey: "vercel", connectionMethodKey: VERCEL_METHOD, url: VERCEL_API_URL };
    expect(isVercelConnection({ transport: "rest_api", config })).toBe(true);
    expect(isVercelConnection({ transport: "rest_api", config: { ...config, url: `${VERCEL_API_URL}/` } })).toBe(true);
    expect(isVercelConnection({ transport: "rest_api", config: { ...config, url: `${VERCEL_API_URL}/?teamId=team_other` } })).toBe(false);
    expect(isVercelConnection({ transport: "mcp_remote", config })).toBe(false);
    expect(isVercelConnection({ transport: "rest_api", config: { ...config, url: "https://evil.invalid" } })).toBe(false);
    expect(VERCEL_TOOLS).toHaveLength(17);
    for (const tool of VERCEL_TOOLS) {
      const entry = { toolName: tool.name, versionHash: descriptorHash(tool, vercelRisk(tool.name)), schemaHash: stableHash(tool.inputSchema), riskLevel: vercelRisk(tool.name) };
      expect(isCurrentVercelCatalogEntry(entry)).toBe(true);
      expect(isCurrentVercelCatalogEntry({ ...entry, schemaHash: "stale" })).toBe(false);
      expect(isCurrentVercelCatalogEntry({ ...entry, riskLevel: "other" })).toBe(false);
    }
    expect(vercelRisk("vercel_create_deployment")).toBe("write");
    expect(vercelRisk("vercel_upsert_environment_variable")).toBe("write");
    expect(vercelRisk("vercel_delete_project")).toBe("destructive");
    expect(vercelRisk("unknown")).toBe("destructive");
  });

  it("probes the configured team with the vaulted credential and forbids redirects", async () => {
    const { request, client } = fixture(() => json({ id: teamId, name: "Fixture" }));
    expect(await client.probe()).toEqual({ teamId });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`${VERCEL_API_URL}/v2/teams/${teamId}?teamId=${teamId}`);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
    const wrong = fixture(() => json({ id: "team_other" }));
    await expect(wrong.client.probe()).rejects.toMatchObject({ status: 403 });
  });

  it("rejects malformed credentials without echoing them from header validation", () => {
    expect(() => vercelClient({ Authorization: `Bearer ${token}\r\nInjected: value` }, vi.fn(), teamId)).toThrow("Reconnect Vercel to restore its access token.");
  });

  it("lists only team projects, bounds pagination and excludes embedded environment values", async () => {
    const { request, client } = fixture(() => json({ projects: [{ ...project, env: [{ value: "hidden" }] }], pagination: { next: "123" } }));
    expect(await client.invoke("vercel_list_projects", { limit: 3, from: "99" })).toEqual({ projects: [project], pagination: { next: "123" } });
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("teamId")).toBe(teamId);
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("from")).toBe("99");
  });

  it.each([
    ["vercel_list_projects", { teamId: "team_other" }],
    ["vercel_get_project", { projectId: "../other" }],
    ["vercel_create_deployment", { projectId: project.id, name: "fixture" }],
    ["vercel_create_deployment", { projectId: project.id, name: "fixture", files: [{ file: "index.html", content: "hi" }], deploymentId: deployment.id }],
    ["vercel_create_deployment", { projectId: project.id, name: "fixture", files: [{ file: "../secret", content: "hi" }] }],
    ["vercel_create_deployment", { projectId: project.id, name: "fixture", files: [{ file: "image.png", content: "not base64!", encoding: "base64" }] }],
    ["vercel_create_deployment", { projectId: project.id, name: "fixture", files: [{ file: "index.html", content: "hi" }], target: "custom-production" }],
    ["vercel_upsert_environment_variable", { projectId: project.id, key: "KEY", secretValue: "fixture", target: ["development"], type: "sensitive" }],
  ])("rejects invalid %s input before provider requests", async (name, args) => {
    const { request, client } = fixture();
    await expect(client.invoke(name, args)).rejects.toMatchObject({ status: 422 });
    expect(request).not.toHaveBeenCalled();
  });

  it("checks project ownership before mutation even when the provider accepts a foreign ID", async () => {
    const request = vi.fn<VercelRequest>(async () => json({ ...project, accountId: "team_other" }));
    await expect(vercelClient(headers, request, teamId).invoke("vercel_update_project", { projectId: project.id, settings: { framework: "nextjs" } })).rejects.toMatchObject({ status: 403 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1].method).toBe("GET");
  });

  it.each([undefined, "preview"])("deploys inline files with target %s after verifying a previous deployment exists", async (target) => {
    const { request, client } = previewFixture({ deployments: [previousDeployment] }, { ...deployment, env: ["hidden"], token });
    expect(await client.invoke("vercel_create_deployment", { ...deploymentArgs, target })).toEqual(deployment);
    expect(request.mock.calls.map(([url, init]) => [new URL(url).pathname, init.method])).toEqual([
      [`/v9/projects/${project.id}`, "GET"], ["/v7/deployments", "GET"], ["/v13/deployments", "POST"],
    ]);
    expect(Object.fromEntries(new URL(request.mock.calls[1]![0]).searchParams)).toEqual({ projectId: project.id, limit: "1", teamId });
    const [url, init] = request.mock.calls[2]!;
    expect(url).toBe(`${VERCEL_API_URL}/v13/deployments?teamId=${teamId}`);
    expect(JSON.parse(String(init.body))).toEqual({ name: "fixture", project: project.id, files: [{ file: "index.html", data: "<h1>Preview</h1>", encoding: "utf-8" }], projectSettings: { framework: null, nodeVersion: "22.x" } });
  });

  it("deploys GitHub sources and sends an explicit production target", async () => {
    const { request, client } = fixture(() => json({ ...deployment, target: "production" }));
    const gitSource = { type: "github", repoId: "123", ref: "main" };
    await client.invoke("vercel_create_deployment", { projectId: project.id, name: "fixture", gitSource, target: "production" });
    expect(JSON.parse(String(request.mock.calls[1]![1].body))).toMatchObject({ gitSource, target: "production", project: project.id });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "preview"])("rejects target %s for an empty project before a deployment can be promoted", async (target) => {
    const { request, client } = previewFixture({ deployments: [] });
    await expect(client.invoke("vercel_create_deployment", { ...deploymentArgs, target })).rejects.toMatchObject({
      status: 409, details: { code: "vercel_preview_requires_existing_deployment" },
      message: expect.stringContaining("target=production"),
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it.each(["ERROR", "CANCELED"])("accepts an existing %s deployment as the preview prerequisite", async (state) => {
    const { client } = previewFixture({ deployments: [{ ...previousDeployment, state }] });
    expect(await client.invoke("vercel_create_deployment", deploymentArgs)).toEqual(deployment);
  });

  it.each([
    [null, 502],
    [{ deployments: {} }, 502],
    [{ deployments: [null] }, 502],
    [{ deployments: [{ projectId: project.id, uid: "invalid" }] }, 502],
    [{ deployments: [{ ...previousDeployment, projectId: "prj_other" }] }, 403],
  ])("rejects an unverified preview prerequisite %j before mutation", async (existing, status) => {
    const { request, client } = previewFixture(existing);
    await expect(client.invoke("vercel_create_deployment", deploymentArgs)).rejects.toMatchObject({ status });
    expect(request.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it.each(["production", undefined, "staging", { unexpected: token }])("returns a bounded reconciliation receipt for preview response target %j", async (target) => {
    const { request, client } = previewFixture({ deployments: [previousDeployment] }, {
      ...deployment, target, url: token, env: [{ value: token }], unknown: token,
    });
    expect(await client.invoke("vercel_create_deployment", deploymentArgs)).toEqual({
      id: deployment.id, projectId: project.id, requestedTarget: "preview",
      target: target === "production" ? "production" : "unknown", reconciliationRequired: true,
      code: "vercel_deployment_target_mismatch",
      message: "Vercel created a deployment without confirming the requested preview environment. Inspect this deployment before any retry; it may use Production environment variables and domains.",
    });
    expect(request.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(request.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(false);
  });

  it("cancels a preview prerequisite without a late deployment write", async () => {
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const request = vi.fn<VercelRequest>(async (url) => {
      if (new URL(url).pathname === `/v9/projects/${project.id}`) return json(project);
      markStarted();
      return new Promise(resolve => { finish = resolve; });
    });
    const outcome = vercelClient(headers, request, teamId, controller.signal).invoke("vercel_create_deployment", deploymentArgs)
      .then(() => null, error => error);
    await started;
    expect(new URL(request.mock.calls[1]![0]).pathname).toBe("/v7/deployments");
    controller.abort();
    expect(await outcome).toMatchObject({ status: 504 });
    finish(json({ deployments: [previousDeployment] }));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it("checks deployment project identity before deleting, cancelling, or redeploying", async () => {
    const request = vi.fn<VercelRequest>(async (url) => new URL(url).pathname.startsWith("/v9/projects/") ? json(project) : json({ ...deployment, projectId: "prj_other" }));
    await expect(vercelClient(headers, request, teamId).invoke("vercel_delete_deployment", { projectId: project.id, deploymentId: deployment.id })).rejects.toMatchObject({ status: 403 });
    expect(request.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it("rejects a deployment list containing another project's data", async () => {
    const { client } = fixture(() => json({ deployments: [{ ...deployment, projectId: "prj_other" }] }));
    await expect(client.invoke("vercel_list_deployments", { projectId: project.id })).rejects.toMatchObject({ status: 403 });
  });

  it("updates project configuration and returns only the saved settings", async () => {
    const settings = { framework: "vite", buildCommand: "pnpm build", outputDirectory: "dist", rootDirectory: null };
    const { request, client } = fixture(() => json({ ...project, ...settings, env: [{ value: "hidden" }] }));
    expect(await client.invoke("vercel_update_project", { projectId: project.id, settings })).toEqual({ ...project, ...settings });
    const [url, init] = request.mock.calls[1]!;
    expect(url).toBe(`${VERCEL_API_URL}/v9/projects/${project.id}?teamId=${teamId}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual(settings);
  });

  it("returns domain verification records for an attached domain without purchasing or changing DNS", async () => {
    const response = { name: "app.example.com", verified: false, verification: [{ type: "TXT", domain: "_vercel.example.com", value: "vc-domain-verify=fixture" }] };
    const { request, client } = fixture(() => json(response));
    expect(await client.invoke("vercel_add_domain", { projectId: project.id, domain: response.name })).toEqual(response);
    expect(new URL(request.mock.calls[1]![0]).pathname).toBe(`/v10/projects/${project.id}/domains`);
    expect(JSON.parse(String(request.mock.calls[1]![1].body))).toEqual({ name: response.name });
  });

  it("sets encrypted environment values without echoing provider secrets or storing them in audit snapshots", async () => {
    const secretValue = "fixture-environment-value";
    const args = { projectId: project.id, key: "API_KEY", secretValue, target: ["preview"] };
    const { request, client } = fixture(() => json({ created: { id: "env_fixture", key: "API_KEY", value: secretValue, vsmValue: "hidden", type: "encrypted", target: ["preview"] }, failed: [] }));
    expect(await client.invoke("vercel_upsert_environment_variable", args)).toEqual({ id: "env_fixture", key: "API_KEY", type: "encrypted", target: ["preview"] });
    expect(JSON.parse(String(request.mock.calls[1]![1].body))).toEqual({ key: "API_KEY", value: secretValue, type: "encrypted", target: ["preview"] });
    expect(JSON.stringify(redactEventPayload(args))).not.toContain(secretValue);
    expect(new URL(request.mock.calls[1]![0]).searchParams.get("upsert")).toBe("true");
  });

  it("treats environment partial-failure responses as failure without exposing their values", async () => {
    const { client } = fixture(() => json({ created: [], failed: [{ error: { message: token, value: "private-value" } }] }));
    await expect(client.invoke("vercel_upsert_environment_variable", { projectId: project.id, key: "API_KEY", secretValue: "private-value", target: ["preview"] })).rejects.toMatchObject({ status: 422, message: "Vercel rejected the environment variable. Check the key, targets and provider permissions." });
  });

  it("never decrypts environment variables and strips values from metadata", async () => {
    const { request, client } = fixture(() => json({ envs: [{ id: "env_fixture", key: "API_KEY", value: "private-value", decrypted: true }] }));
    expect(await client.invoke("vercel_list_environment_variables", { projectId: project.id })).toEqual({ envs: [{ id: "env_fixture", key: "API_KEY" }] });
    expect(new URL(request.mock.calls[1]![0]).searchParams.get("decrypt")).toBe("false");
  });

  it("reports safe provider failures and never retries uncertain writes", async () => {
    const { request, client } = fixture(() => { throw new Error(`network error ${token}`); });
    await expect(client.invoke("vercel_create_project", { name: "fixture" })).rejects.toMatchObject({ status: 502, message: "Vercel did not return a result. A submitted operation may still complete; inspect its state before retrying." });
    expect(request).toHaveBeenCalledTimes(1);
    const rejected = fixture(() => json({ error: { message: token } }, 403));
    await expect(rejected.client.invoke("vercel_create_project", { name: "fixture" })).rejects.toMatchObject({ status: 403, message: "Vercel denied access. Check the access token's team scope, expiration and role, then reconnect." });
    const forged = fixture(() => { throw new HttpError(504, `network error ${token}`, { code: "vercel_deadline_exceeded" }); });
    await expect(forged.client.invoke("vercel_create_project", { name: "fixture" })).rejects.toMatchObject({ status: 502,
      message: "Vercel did not return a result. A submitted operation may still complete; inspect its state before retrying." });
    expect(forged.request).toHaveBeenCalledTimes(1);
  });

  it("redacts exact connection tokens even if returned in allowed fields or object keys", async () => {
    const { client } = fixture(() => json({ domains: [{ name: token, verification: [{ [token]: token }] }] }));
    expect(JSON.stringify(await client.invoke("vercel_list_domains", { projectId: project.id }))).not.toContain(token);
  });

  it("expires slow prerequisites before the wall-clock threshold without a late write and keeps other requests responsive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      let finish!: (response: Response) => void;
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const request = vi.fn<VercelRequest>(() => new Promise(resolve => {
        finish = resolve;
        markStarted();
      }));
      const deadlineAt = now + 30;
      const pending = vercelClient(headers, request, teamId, new AbortController().signal, deadlineAt)
        .invoke("vercel_delete_project", { projectId: project.id });
      const outcome = pending.then(() => null, error => error);
      await started;
      expect(await fixture(() => json({ id: teamId })).client.probe()).toEqual({ teamId });
      await vi.advanceTimersByTimeAsync(30);
      expect(Date.now()).toBeLessThan(deadlineAt);
      expect(await outcome).toMatchObject({ status: 504, details: { code: "vercel_deadline_exceeded" } });
      finish(json(project));
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]![1].method).toBe("GET");
    } finally {
      wallClock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not expose arbitrary transport HTTP errors from response streams", async () => {
    const { client } = fixture(() => new Response(new ReadableStream({
      start(controller) {
        controller.error(new HttpError(504, `stream error ${token}`, { code: "vercel_deadline_exceeded" }));
      },
    })));
    await expect(client.probe()).rejects.toMatchObject({ status: 502,
      message: "Vercel's response was interrupted. Inspect the operation before retrying." });
  });

  it("bounds a response stream even if its reader stalls", async () => {
    vi.useFakeTimers();
    try {
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const request = vi.fn<VercelRequest>(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          markStarted();
        },
      })));
      const pending = vercelClient(headers, request, teamId, new AbortController().signal, Date.now() + 20).probe();
      const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
      await started;
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
