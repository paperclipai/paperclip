import { describe, expect, it, vi } from "vitest";
import { runnerApiCatalog, runnerApiOperation, searchRunnerApi } from "./runner-api-catalog.js";
import { executeRunnerApi, readBoundedResponse, runnerApiUrl, validateRunnerApiCall, type RunnerApiIo } from "./runner-api-client.js";

const context = { companyId: "company-a", issueId: "issue-a", issueIdentifier: "API-1", runId: "run-a", workMode: "standard" };
const projects = "GET /api/companies/{companyId}/projects";
const createProject = "POST /api/companies/{companyId}/projects";
const io = (fetcher: typeof fetch): RunnerApiIo => ({ apiUrl: "http://127.0.0.1:3100", token: "private-agent-token", fetch: fetcher, readFile: async () => ({ bytes: Buffer.from("test"), filename: "proof.txt", contentType: "text/plain" }), saveResponse: async (bytes, contentType) => ({ artifactId: "artifact-a", byteSize: bytes.length, contentType }) });

describe("runner API catalog", () => {
  it("accounts for unique operations with resolved request contracts", () => {
    const catalog = runnerApiCatalog();
    expect(catalog.length).toBeGreaterThan(400);
    expect(new Set(catalog.map((entry) => entry.operationId)).size).toBe(catalog.length);
    expect(JSON.stringify(catalog)).not.toContain('"$ref"');
    expect(runnerApiOperation("GET /api/companies/{companyId}/decisions").authorization.actor).toBe("board");
    expect(runnerApiOperation("DELETE /api/issues/{id}/documents/{key}").authorization.actor).toBe("board");
    expect(runnerApiOperation("DELETE /api/issues/{id}/documents/{key}").dedicatedTools).toEqual([]);
    expect(runnerApiOperation(createProject).requestBody?.content["application/json"].schema.required).toContain("name");
  });
  it.each(runnerApiCatalog().filter(operation => operation.transport === "rest"))("resolves the catalog route $operationId inside the bound origin", operation => {
    const pathParams = Object.fromEntries(operation.parameters.filter(parameter => parameter.in === "path").map(parameter => [parameter.name, parameter.name === "companyId" ? context.companyId : "fixture-id"]));
    const url = runnerApiUrl(operation, { operationId: operation.operationId, pathParams }, context, "https://paperclip.test");
    expect(url.origin).toBe("https://paperclip.test");
    expect(url.pathname).not.toContain("{");
    expect(operation.responses).toBeDefined();
    expect(operation.authorization.actor).toBeTruthy();
  });
  it("ranks natural language, explains dedicated alternatives, and supports exact lookup", () => {
    expect(searchRunnerApi({ query: "create project" }).results.map((entry) => entry.operationId)).toContain(createProject);
    expect(searchRunnerApi({ query: "GET /api/companies/{companyId}/issues" }).results[0].dedicatedTools).toContain("search_tasks");
    expect(searchRunnerApi({ query: "nothing-zzzzzzzzzz" }).total).toBe(0);
  });
  it("paginates without duplicates and rejects stale or mismatched cursors", () => {
    const first = searchRunnerApi({ query: "project", limit: 1 });
    const second = searchRunnerApi({ query: "project", limit: 1, cursor: first.nextCursor! });
    expect(second.results[0].operationId).not.toBe(first.results[0].operationId);
    expect(() => searchRunnerApi({ query: "agent", cursor: first.nextCursor! })).toThrow("different query");
    expect(() => searchRunnerApi({ query: "project", limit: 50 })).toThrow();
  });
});

describe("runner API request boundary", () => {
  it.each([
    "POST /api/execution-workspaces/{id}/runtime-commands/{action}",
    "POST /api/projects/{id}/workspaces/{workspaceId}/runtime-services/{action}",
    "POST /api/tool-gateway/runtime-slots/{slotId}/restart",
    "POST /api/cases/{caseId}/automation/current-stage/rerun",
    "POST /api/companies/{companyId}/skills/{skillId}/test-runs",
    "POST /api/tool-gateway/sessions",
  ])("keeps execution and gateway control %s out of generic dispatch", async operationId => {
    const request = vi.fn<typeof fetch>();
    await expect(executeRunnerApi({ operationId }, context, io(request))).rejects.toThrow(/cannot bypass|credential broker/);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "POST /api/agents/{id}/claude-login",
    "POST /api/companies/{companyId}/adapters/{type}/login-sessions",
    "POST /api/agents/me/connections/{connectionId}/start-authorization",
  ])("directs authentication handshake %s to its existing client", async operationId => {
    const request = vi.fn<typeof fetch>();
    expect(runnerApiOperation(operationId).transport).toBe("protocol");
    await expect(executeRunnerApi({ operationId }, context, io(request))).rejects.toThrow("existing protocol client");
    expect(request).not.toHaveBeenCalled();
  });
  it.each(runnerApiCatalog().filter(operation => !["GET", "HEAD", "OPTIONS"].includes(operation.method) && /\/(routines|routine-triggers)(\/|$)/.test(operation.path) && !operation.path.includes("/description/annotations")))("keeps scheduled execution $operationId behind its existing client", async operation => {
    const request = vi.fn<typeof fetch>();
    await expect(executeRunnerApi({ operationId: operation.operationId }, context, io(request))).rejects.toThrow(/cannot bypass|credential broker/);
    expect(request).not.toHaveBeenCalled();
    expect(operation.callPolicy).toBe("restricted");
  });
  it.each(runnerApiCatalog().filter(operation => !["GET", "HEAD", "OPTIONS"].includes(operation.method) && operation.path.includes("/routines/{id}/description/annotations")))("preserves routine collaboration $operationId", async operation => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ id: "thread", status: "open" }));
    const pathParams = Object.fromEntries(operation.parameters.filter(parameter => parameter.in === "path").map(parameter => [parameter.name, "fixture"]));
    await expect(executeRunnerApi({ operationId: operation.operationId, pathParams }, context, io(request))).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledOnce();
    expect(operation.callPolicy).toBe("rest");
  });
  it("keeps routine metadata readable", () => {
    expect(validateRunnerApiCall({ operationId: "GET /api/companies/{companyId}/routines" }, context).operation.callPolicy).toBe("rest");
  });
  it.each(["reopen", "resume", "interrupt"])("cannot hide lifecycle intent %s in an ordinary issue patch", async field => {
    const request = vi.fn<typeof fetch>();
    await expect(executeRunnerApi({ operationId: "PATCH /api/issues/{id}", pathParams: { id: "other-issue" }, body: { [field]: true, billingCode: "safe-extra-field" } }, context, io(request))).rejects.toThrow("lifecycle changes");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "POST /api/agents/me/secrets/{key}/value",
    "POST /api/agents/{id}/keys",
    "DELETE /api/agents/{id}/keys/{keyId}",
    "POST /api/companies/{companyId}/secret-proposals/{id}/approve",
    "POST /api/agents/me/secret-proposals",
    "PATCH /api/secrets/{id}",
    "POST /api/companies/{companyId}/exports",
    "GET /api/secret-provider-configs/{id}",
  ])("keeps sensitive operation %s out of model results and receipts", async operationId => {
    const request = vi.fn<typeof fetch>();
    await expect(executeRunnerApi({ operationId }, context, io(request))).rejects.toThrow("credential broker");
    expect(request).not.toHaveBeenCalled();
    expect(searchRunnerApi({ query: operationId }).results[0]).toMatchObject({ callPolicy: "restricted" });
  });
  it("retains safe secret metadata discovery", () => {
    for (const operationId of ["GET /api/agents/me/secrets", "GET /api/companies/{companyId}/secrets/catalog"]) {
      expect(validateRunnerApiCall({ operationId }, context).operation.callPolicy).toBe("rest");
    }
  });
  it("binds the company and encodes query scalars", () => {
    const input = { operationId: projects, query: { q: "hello & goodbye", limit: 2, active: false } };
    const url = runnerApiUrl(runnerApiOperation(projects), input, context, "https://paperclip.test/api");
    expect(url.origin).toBe("https://paperclip.test");
    expect(url.pathname).toBe("/api/companies/company-a/projects");
    expect(url.searchParams.get("q")).toBe("hello & goodbye");
  });
  it.each(["../secrets", ".", "..", "%2e%2e", "abc/def", "abc\\def"])("rejects path injection %s", (id) => {
    const input = { operationId: "GET /api/projects/{id}", pathParams: { id } };
    expect(() => runnerApiUrl(runnerApiOperation(input.operationId), input, context, "https://paperclip.test")).toThrow();
  });
  it("rejects unknown inputs, foreign companies, and mode bypasses", () => {
    expect(() => validateRunnerApiCall({ operationId: projects, headers: { Authorization: "board" } }, context)).toThrow();
    expect(() => validateRunnerApiCall({ operationId: projects, pathParams: { companyId: "foreign" } }, context)).toThrow("another company");
    for (const workMode of ["planning", "ask"]) {
      expect(() => validateRunnerApiCall({ operationId: createProject, body: { name: "bad" } }, { ...context, workMode })).toThrow("only reads");
      expect(validateRunnerApiCall({ operationId: projects }, { ...context, workMode }).operation.method).toBe("GET");
    }
  });
  it("retains API-only issue options while guarding lifecycle fields", () => {
    const input = { operationId: "PATCH /api/issues/{id}", pathParams: { id: context.issueId }, body: { billingCode: "cost-center" } };
    expect(validateRunnerApiCall(input, context).operation.method).toBe("PATCH");
    expect(() => validateRunnerApiCall({ ...input, body: { status: "done" } }, context)).toThrow("dedicated");
    expect(() => validateRunnerApiCall({ operationId: "POST /api/issues/{id}/checkout", pathParams: { id: context.issueId } }, context)).toThrow("lifecycle");
  });
  it.each(["issue-a", "ISSUE-A", "API-1", "api-1", " api-1 "])("cannot delete its active task using the route identity alias %s", id => {
    expect(() => validateRunnerApiCall({ operationId: "DELETE /api/issues/{id}", pathParams: { id } }, context)).toThrow("cannot delete itself");
  });
  it("forwards only server-owned authentication and preserves API denials", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Board access required" }, { status: 403 }));
    const result = await executeRunnerApi({ operationId: projects }, context, io(request));
    expect(result).toMatchObject({ ok: false, status: 403, data: { error: "Board access required" } });
    const options = request.mock.calls[0][1]!;
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer private-agent-token");
    expect(new Headers(options.headers).get("X-Paperclip-Run-Id")).toBe(context.runId);
    expect(options.redirect).toBe("manual");
    expect(JSON.stringify(result)).not.toContain("private-agent-token");
  });
  it("never retries a mutation after a transport failure", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("socket reset"); });
    expect(await executeRunnerApi({ operationId: createProject, body: { name: "created?" } }, context, io(request))).toMatchObject({ outcome: "unknown", status: null });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503, 408, 302])("does not claim a mutation was unapplied after HTTP %s", async status => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Request interrupted after possible commit" }, { status }));
    expect(await executeRunnerApi({ operationId: createProject, body: { name: "Maybe created" } }, context, io(request))).toMatchObject({ status, outcome: "unknown", ok: false });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("retains uncertainty when a successful mutation returns malformed JSON", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("truncated{", { status: 201, headers: { "content-type": "application/json" } }));
    expect(await executeRunnerApi({ operationId: createProject, body: { name: "Maybe created" } }, context, io(request))).toMatchObject({ status: 201, outcome: "unknown", error: "invalid_json_response" });
  });
  it("rejects a string-encoded object before HTTP and allows a corrected request", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ name: "Borealis" }, { status: 201 }));
    await expect(executeRunnerApi({ operationId: createProject, body: '{"name":"Borealis"}' }, context, io(request))).rejects.toThrow("not a JSON-encoded string");
    expect(request).not.toHaveBeenCalled();
    expect(await executeRunnerApi({ operationId: createProject, body: { name: "Borealis" } }, context, io(request))).toMatchObject({ status: 201 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not follow redirects or pretend empty responses failed", async () => {
    expect(await executeRunnerApi({ operationId: projects }, context, io(async () => new Response(null, { status: 302, headers: { Location: "https://foreign.test" } })))).toMatchObject({ ok: false, error: "api_redirect_not_followed" });
    expect(await executeRunnerApi({ operationId: projects }, context, io(async () => new Response(null, { status: 204 })))).toMatchObject({ ok: true, status: 204, data: null });
  });
  it("uploads multipart artifacts and returns download references", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("download", { headers: { "content-type": "application/octet-stream" } }));
    const result = await executeRunnerApi({ operationId: createProject, files: [{ artifactId: "a", field: "package" }], body: { meta: { name: "example" } } }, context, io(request));
    const body = request.mock.calls[0][1]!.body as FormData;
    expect(body.get("meta")).toBe('{"name":"example"}');
    expect(await (body.get("package") as File).text()).toBe("test");
    expect(new Headers(request.mock.calls[0][1]!.headers).has("Content-Type")).toBe(false);
    expect(result).toMatchObject({ artifact: { artifactId: "artifact-a", byteSize: 8 }, preview: null });
  });
  it("encodes text and raw file bodies without pretending they are JSON", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await executeRunnerApi({ operationId: createProject, body: "plain text", contentType: "text/plain" }, context, io(request));
    expect(request.mock.calls[0][1]?.body).toBe("plain text");
    await executeRunnerApi({ operationId: createProject, files: [{ path: "sample.bin" }], contentType: "application/octet-stream" }, context, io(request));
    expect(Buffer.from(request.mock.calls[1][1]?.body as Uint8Array).toString()).toBe("test");
    await expect(executeRunnerApi({ operationId: createProject, body: "unexpected", files: [{ artifactId: "a" }], contentType: "application/octet-stream" }, context, io(request))).rejects.toThrow();
  });
  it("classifies protocols and prevents execution control through alternate routes", () => {
    const protocols = runnerApiCatalog().filter(operation => operation.transport === "protocol");
    expect(protocols.some(operation => operation.path.endsWith("/events/ws"))).toBe(true);
    for (const operation of protocols) expect(() => validateRunnerApiCall({ operationId: operation.operationId }, context)).toThrow("protocol client");
    for (const operationId of ["POST /api/issues/{id}/tree-holds", "POST /api/issues/{id}/stalled-review-decision", "POST /api/agents/{id}/runtime-state/reset-session", "POST /api/approvals/{id}/resubmit"]) {
      expect(() => validateRunnerApiCall({ operationId, pathParams: { id: "fixture" } }, context)).toThrow("cannot bypass");
    }
  });
  it("keeps skill-test mode consistent with the advertised tool contract", () => {
    expect(validateRunnerApiCall({ operationId: createProject, body: { name: "Skill fixture" } }, { ...context, workMode: "skill_test" }).operation.method).toBe("POST");
  });
  it("cannot hide lifecycle mutations in a raw uploaded JSON body", () => {
    for (const operationId of ["PATCH /api/issues/{id}", "PATCH /api/agents/{id}", "POST /api/issues/{id}/comments"]) {
      expect(() => validateRunnerApiCall({ operationId, pathParams: { id: "fixture" }, files: [{ path: "hidden-status.json" }], contentType: "application/json" }, context)).toThrow("inline JSON object");
    }
  });
  it("bounds streamed responses even without content-length", async () => {
    await expect(readBoundedResponse(new Response("too large"), 3)).rejects.toThrow("transfer limit");
  });
});
