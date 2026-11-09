import { describe, expect, it, vi } from "vitest";
import {
  runnerApiCatalog,
  runnerApiOperation,
  searchRunnerApi,
} from "./runner-api-catalog.js";
import {
  executeRunnerApi,
  readBoundedResponse,
  runnerApiUrl,
  validateRunnerApiCall,
  type RunnerApiIo,
} from "./runner-api-client.js";
import { RUNNER_API_RESPONSE_MAX_BYTES } from "./runner-api-response-limits.js";

const context = {
  companyId: "company-a",
  issueId: "issue-a",
  issueIdentifier: "API-1",
  runId: "run-a",
  workMode: "standard",
};
const projects = "GET /api/companies/{companyId}/projects";
const createProject = "POST /api/companies/{companyId}/projects";
const io = (fetcher: typeof fetch): RunnerApiIo => ({
  apiUrl: "http://127.0.0.1:3100",
  token: "private-agent-token",
  fetch: fetcher,
  readFile: async () => ({
    bytes: Buffer.from("test"),
    filename: "proof.txt",
    contentType: "text/plain",
  }),
  saveResponse: async (bytes, contentType) => ({
    artifactId: "artifact-a",
    byteSize: Buffer.isBuffer(bytes) ? bytes.length : bytes.byteSize,
    contentType,
  }),
});

describe("bounded response capture receipts", () => {
  it.each([projects, createProject])("reports oversize evidence without retrying %s", async operationId => {
    const fetcher = vi.fn(async () => new Response("", { headers: { "content-length": String(RUNNER_API_RESPONSE_MAX_BYTES + 1) } }));
    const result = await executeRunnerApi({ operationId }, context, io(fetcher));
    expect(result).toMatchObject({ ok: false, error: "api_response_too_large", maxResponseBytes: RUNNER_API_RESPONSE_MAX_BYTES,
      outcome: operationId === projects ? "read_failed" : "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("settles the budget and removes the file even when saving fails", async () => {
    const bytes = Buffer.alloc(32 * 1024);
    const settle = vi.fn(async () => {});
    const input = io(async () => new Response(bytes));
    input.reserveResponseCapture = async () => settle;
    input.saveResponse = async () => { throw new Error("storage unavailable"); };
    await expect(executeRunnerApi({ operationId: projects }, context, input)).rejects.toThrow("storage unavailable");
    expect(settle).toHaveBeenCalledExactlyOnceWith(bytes.length, true);
  });
});

describe("runner API catalog", () => {
  it("discovers the real handoff schema and recovery endpoints with standard-mode mutation authority", () => {
    const operation = runnerApiOperation("POST /api/companies/{companyId}/case-handoffs");
    expect(operation.dedicatedTools).toEqual(["handoff_case", "create_case"]);
    expect(operation.allowedModes).toEqual(["standard"]);
    expect(operation.requestBody?.content["application/json"].schema).toMatchObject({ oneOf: [
      { additionalProperties: false, required: expect.arrayContaining(["case", "toAgentId", "phase", "instructions", "idempotencyKey", "workflow_document_text"]),
        properties: { case: { required: ["create"] }, workflow_document_text: { type: "string", maxLength: 200000, pattern: "\\S" } } },
      { additionalProperties: false, required: expect.arrayContaining(["case", "toAgentId", "phase", "instructions", "idempotencyKey", "workflowId"]),
        properties: { case: { required: ["create"] }, workflowId: { type: "string", format: "uuid" } } },
      { additionalProperties: false, required: expect.arrayContaining(["case", "toAgentId", "phase", "instructions", "idempotencyKey"]),
        properties: { case: { required: ["id"] } } },
      { additionalProperties: false, required: expect.arrayContaining(["to", "case", "instructions", "idempotencyKey"]),
        properties: { to: { enum: ["done"] } } },
    ] });
    const branches = operation.requestBody!.content["application/json"].schema.oneOf;
    expect(branches[1].required).not.toContain("workflow_document_text");
    expect(branches[3].properties).not.toHaveProperty("workflow_document_text");
    expect(operation.responses).toHaveProperty("202");
    expect(runnerApiOperation("GET /api/cases/{caseId}/handoffs").parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cursor" })]));
    for (const action of ["retry", "cancel"]) expect(runnerApiOperation(`POST /api/cases/{caseId}/handoffs/{handoffId}/${action}`).allowedModes).toEqual(["standard"]);
  });
  it("maps dedicated case data tools and describes the optional metadata projection", () => {
    for (const [operationId, tool] of [
      ["GET /api/cases/{id}", "read_case"], ["PATCH /api/cases/{id}", "update_case"],
      ["GET /api/companies/{companyId}/workflows", "list_workflows"], ["POST /api/companies/{companyId}/workflows", "create_workflow"],
      ["GET /api/workflows/{id}", "read_workflow"], ["PATCH /api/workflows/{id}", "update_workflow"],
    ]) expect(runnerApiOperation(operationId!).dedicatedTools).toEqual([tool]);
    const legacyCreate = runnerApiOperation("POST /api/companies/{companyId}/cases");
    expect(legacyCreate.dedicatedTools).toEqual([]);
    expect(legacyCreate.requestBody?.content["application/json"].schema.properties).not.toHaveProperty("createOnly");
    for (const method of ["GET", "PUT"]) expect(runnerApiOperation(`${method} /api/cases/{id}/documents/{key}`).dedicatedTools).toEqual([]);
    expect(runnerApiOperation("GET /api/cases/{id}").parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "includeDocumentBodies", in: "query" }),
    ]));
  });
  it.each(["standard", "ask", "planning", "skill_test"])("permits the title-only API in %s mode", workMode => {
    const operationId = "PUT /api/issues/{id}/title";
    const { operation } = validateRunnerApiCall({
      operationId,
      pathParams: { id: context.issueId },
      body: { title: "Fix sign-in redirect", onlyIfProvisional: true },
    }, { ...context, workMode });
    expect(operation.allowedModes).toContain(workMode);
    expect(operation.dedicatedTools).toEqual(["set_task_title"]);
    expect(operation.requestBody?.content["application/json"].schema.additionalProperties).toBe(false);
  });
  it("advertises the conversational recording exception without general approval authority", () => {
    const operationId = "POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment";
    const operation = runnerApiOperation(operationId);
    expect(operation.allowedModes).toContain("planning");
    expect(operation.allowedModes).not.toContain("ask");
    expect(operation.runnerRestrictions?.join(" ")).toContain("conversational confirmation");
    expect(runnerApiOperation("POST /api/issues/{id}/interactions/{interactionId}/accept").callPolicy).toBe("rest");
    expect(runnerApiOperation(createProject).allowedModes).not.toContain("planning");
  });
  it("accounts for unique operations with resolved request contracts", () => {
    const catalog = runnerApiCatalog();
    expect(catalog.length).toBeGreaterThan(400);
    expect(new Set(catalog.map((entry) => entry.operationId)).size).toBe(
      catalog.length,
    );
    expect(JSON.stringify(catalog)).not.toContain('"$ref"');
    expect(runnerApiOperation("GET /api/companies/{companyId}/decisions").authorization.actor).toBe("board");
    expect(runnerApiOperation("DELETE /api/issues/{id}/documents/{key}").authorization.actor).toBe("board");
    expect(runnerApiOperation("DELETE /api/issues/{id}/documents/{key}").dedicatedTools).toEqual([]);
    expect(runnerApiOperation(createProject).requestBody?.content["application/json"].schema.required).toContain("name");
    expect(runnerApiOperation(createProject).dedicatedTools).toEqual(["create_project"]);
    expect(runnerApiOperation(projects).dedicatedTools).toEqual(["list_projects"]);
    expect(runnerApiOperation("GET /api/companies/{companyId}/project-repositories").dedicatedTools).toEqual(["list_project_repositories"]);
    expect(runnerApiOperation("GET /api/agents/{id}/instructions-bundle/file").dedicatedTools).toEqual(["read_agent_instructions"]);
    expect(runnerApiOperation("PUT /api/agents/{id}/instructions-bundle/file").dedicatedTools).toEqual(["update_agent_instructions"]);
    expect(runnerApiOperation("GET /api/agents/{id}/instructions-bundle/history").dedicatedTools).toEqual(["get_agent_instruction_history"]);
    expect(runnerApiOperation("POST /api/agents/{id}/instructions-bundle/restore").dedicatedTools).toEqual(["restore_agent_instructions"]);
    expect(runnerApiOperation("POST /api/companies/{companyId}/agent-hires").dedicatedTools).toEqual(["hire_agent"]);
    expect(runnerApiOperation("POST /api/companies/{companyId}/agent-hires").dedicatedToolGuidance).toContain("inherits the caller's native runtime");
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
    expect(
      searchRunnerApi({ query: "create project" }).results.map(
        (entry) => entry.operationId,
      ),
    ).toContain(createProject);
    expect(
      searchRunnerApi({ query: "GET /api/companies/{companyId}/issues" })
        .results[0].dedicatedTools,
    ).toContain("search_tasks");
    expect(searchRunnerApi({ query: "nothing-zzzzzzzzzz" }).total).toBe(0);
  });
  it("paginates without duplicates and rejects stale or mismatched cursors", () => {
    const first = searchRunnerApi({ query: "project", limit: 1 });
    const second = searchRunnerApi({
      query: "project",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.results[0].operationId).not.toBe(
      first.results[0].operationId,
    );
    expect(() =>
      searchRunnerApi({ query: "agent", cursor: first.nextCursor! }),
    ).toThrow("different query");
    expect(() => searchRunnerApi({ query: "project", limit: 50 })).toThrow();
  });
});

describe("runner API request boundary", () => {
  it.each(runnerApiCatalog().filter(operation => operation.transport === "rest"))(
    "dispatches $operationId with agent identity and preserves route authorization",
    async operation => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ error: "Route permission required" }, { status: 403 }),
      );
      const pathParams = Object.fromEntries(
        [...operation.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) =>
          [name, name === "companyId" ? context.companyId : "fixture"]),
      );
      const result = await executeRunnerApi(
        { operationId: operation.operationId, pathParams }, context, io(request),
      );
      expect(operation.callPolicy).toBe("rest");
      expect(result).toMatchObject({ ok: false, status: 403, data: { error: "Route permission required" } });
      expect(request).toHaveBeenCalledOnce();
      const headers = new Headers(request.mock.calls[0][1]?.headers);
      expect(headers.get("Authorization")).toBe("Bearer private-agent-token");
      expect(headers.get("X-Paperclip-Run-Id")).toBe(context.runId);
    },
  );
  it.each([
    "POST /api/mcp/project-tools",
    "POST /api/agents/{id}/claude-login",
    "POST /api/companies/{companyId}/adapters/{type}/login-sessions",
    "POST /api/agents/me/connections/{connectionId}/start-authorization",
  ])(
    "directs authentication handshake %s to its existing client",
    async (operationId) => {
      const request = vi.fn<typeof fetch>();
      expect(runnerApiOperation(operationId).transport).toBe("protocol");
      await expect(
        executeRunnerApi({ operationId }, context, io(request)),
      ).rejects.toThrow("existing protocol client");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each(
    runnerApiCatalog().filter(
      (operation) =>
        !["GET", "HEAD", "OPTIONS"].includes(operation.method) &&
        operation.path.includes("/routines/{id}/description/annotations"),
    ),
  )("preserves routine collaboration $operationId", async (operation) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "thread", status: "open" }),
    );
    const pathParams = Object.fromEntries(
      operation.parameters
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => [parameter.name, "fixture"]),
    );
    await expect(
      executeRunnerApi(
        { operationId: operation.operationId, pathParams },
        context,
        io(request),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledOnce();
    expect(operation.callPolicy).toBe("rest");
  });
  it("keeps routine metadata readable", () => {
    expect(
      validateRunnerApiCall(
        { operationId: "GET /api/companies/{companyId}/routines" },
        context,
      ).operation.callPolicy,
    ).toBe("rest");
  });
  it.each([
    ["PATCH /api/issues/{id}", { status: "blocked", assigneeAgentId: "teammate", blockedByIssueIds: ["dependency"], reopen: true }],
    ["PATCH /api/agents/{id}", { status: "idle" }],
    ["POST /api/issues/{id}/comments", { body: "Continue", resume: true }],
  ])("passes REST payload fields to route authorization for %s", async (operationId, body) => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ accepted: true }));
    expect(await executeRunnerApi({ operationId: operationId as string, pathParams: { id: "fixture" }, body }, context, io(request)))
      .toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual(body);
  });
  it("retains safe secret metadata discovery", () => {
    for (const operationId of [
      "GET /api/agents/me/secrets",
      "GET /api/companies/{companyId}/secrets/catalog",
    ]) {
      expect(
        validateRunnerApiCall({ operationId }, context).operation.callPolicy,
      ).toBe("rest");
    }
  });
  it("binds the company and encodes query scalars", () => {
    const input = {
      operationId: projects,
      query: { q: "hello & goodbye", limit: 2, active: false },
    };
    const url = runnerApiUrl(
      runnerApiOperation(projects),
      input,
      context,
      "https://paperclip.test/api",
    );
    expect(url.origin).toBe("https://paperclip.test");
    expect(url.pathname).toBe("/api/companies/company-a/projects");
    expect(url.searchParams.get("q")).toBe("hello & goodbye");
  });
  it.each(["../secrets", ".", "..", "%2e%2e", "abc/def", "abc\\def"])(
    "rejects path injection %s",
    (id) => {
      const input = {
        operationId: "GET /api/projects/{id}",
        pathParams: { id },
      };
      expect(() =>
        runnerApiUrl(
          runnerApiOperation(input.operationId),
          input,
          context,
          "https://paperclip.test",
        ),
      ).toThrow();
    },
  );
  it("rejects unknown inputs, foreign companies, and mode bypasses", () => {
    expect(() =>
      validateRunnerApiCall(
        { operationId: projects, headers: { Authorization: "board" } },
        context,
      ),
    ).toThrow();
    expect(() =>
      validateRunnerApiCall(
        { operationId: projects, pathParams: { companyId: "foreign" } },
        context,
      ),
    ).toThrow("another company");
    for (const workMode of ["planning", "ask"]) {
      expect(() =>
        validateRunnerApiCall(
          { operationId: createProject, body: { name: "bad" } },
          { ...context, workMode },
        ),
      ).toThrow("only reads");
      expect(
        validateRunnerApiCall(
          { operationId: projects },
          { ...context, workMode },
        ).operation.method,
      ).toBe("GET");
    }
  });
  it.each([
    ["POST /api/agents/me/secrets/{key}/value", { key: "FIXTURE_TOKEN" }],
    ["POST /api/companies/{companyId}/exports", {}],
    ["POST /api/companies/{companyId}/export", {}],
  ])("returns credential responses for %s above the inline limit without plaintext artifacts", async (operationId, pathParams) => {
    const value = "fixture-credential-".repeat(3000);
    const transport = io(async () => Response.json({ value }));
    const save = vi.fn(transport.saveResponse);
    const reserve = vi.fn(async () => vi.fn(async () => {}));
    const result = await executeRunnerApi({ operationId, pathParams }, context, { ...transport, saveResponse: save, reserveResponseCapture: reserve });
    expect(result).toMatchObject({ ok: true, status: 200, data: { value } });
    expect(result).not.toHaveProperty("artifact");
    expect(save).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
  it("withholds a credential response when the run is revoked during HTTP", async () => {
    let authorized = true;
    const request = vi.fn<typeof fetch>(async () => {
      authorized = false;
      return Response.json({ value: "private-fixture-value" });
    });
    const result = await executeRunnerApi({ operationId: "POST /api/agents/me/secrets/{key}/value", pathParams: { key: "fixture-key" } }, context, {
      ...io(request), beforeDispatch: async () => { if (!authorized) throw new Error("Run revoked"); },
    });
    expect(result).toMatchObject({ ok: false, error: "api_transport_failure", outcome: "unknown" });
    expect(JSON.stringify(result)).not.toContain("private-fixture-value");
    expect(request).toHaveBeenCalledOnce();
  });
  it("forwards only server-owned authentication and preserves API denials", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "Board access required" }, { status: 403 }),
    );
    const result = await executeRunnerApi(
      { operationId: projects },
      context,
      io(request),
    );
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      data: { error: "Board access required" },
    });
    const options = request.mock.calls[0][1]!;
    expect(new Headers(options.headers).get("Authorization")).toBe(
      "Bearer private-agent-token",
    );
    expect(new Headers(options.headers).get("X-Paperclip-Run-Id")).toBe(
      context.runId,
    );
    expect(options.redirect).toBe("manual");
    expect(JSON.stringify(result)).not.toContain("private-agent-token");
  });
  it("never retries a mutation after a transport failure", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error("socket reset");
    });
    expect(
      await executeRunnerApi(
        { operationId: createProject, body: { name: "created?" } },
        context,
        io(request),
      ),
    ).toMatchObject({ outcome: "unknown", status: null });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503, 408, 302])(
    "does not claim a mutation was unapplied after HTTP %s",
    async (status) => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json(
          { error: "Request interrupted after possible commit" },
          { status },
        ),
      );
      expect(
        await executeRunnerApi(
          { operationId: createProject, body: { name: "Maybe created" } },
          context,
          io(request),
        ),
      ).toMatchObject({ status, outcome: "unknown", ok: false });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("retains uncertainty when a successful mutation returns malformed JSON", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response("truncated{", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      await executeRunnerApi(
        { operationId: createProject, body: { name: "Maybe created" } },
        context,
        io(request),
      ),
    ).toMatchObject({
      status: 201,
      outcome: "unknown",
      error: "invalid_json_response",
    });
  });
  it("rejects a string-encoded object before HTTP and allows a corrected request", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ name: "Borealis" }, { status: 201 }),
    );
    await expect(
      executeRunnerApi(
        { operationId: createProject, body: '{"name":"Borealis"}' },
        context,
        io(request),
      ),
    ).rejects.toThrow("not a JSON-encoded string");
    expect(request).not.toHaveBeenCalled();
    expect(
      await executeRunnerApi(
        { operationId: createProject, body: { name: "Borealis" } },
        context,
        io(request),
      ),
    ).toMatchObject({ status: 201 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not follow redirects or pretend empty responses failed", async () => {
    expect(
      await executeRunnerApi(
        { operationId: projects },
        context,
        io(
          async () =>
            new Response(null, {
              status: 302,
              headers: { Location: "https://foreign.test" },
            }),
        ),
      ),
    ).toMatchObject({ ok: false, error: "api_redirect_not_followed" });
    expect(
      await executeRunnerApi(
        { operationId: projects },
        context,
        io(async () => new Response(null, { status: 204 })),
      ),
    ).toMatchObject({ ok: true, status: 204, data: null });
  });
  it("uploads multipart artifacts and returns download references", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response("download", {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const result = await executeRunnerApi(
      {
        operationId: createProject,
        files: [{ artifactId: "a", field: "package" }],
        body: { meta: { name: "example" } },
      },
      context,
      io(request),
    );
    const body = request.mock.calls[0][1]!.body as FormData;
    expect(body.get("meta")).toBe('{"name":"example"}');
    expect(await (body.get("package") as File).text()).toBe("test");
    expect(
      new Headers(request.mock.calls[0][1]!.headers).has("Content-Type"),
    ).toBe(false);
    expect(result).toMatchObject({
      artifact: { artifactId: "artifact-a", byteSize: 8 },
      preview: null,
    });
  });
  it("encodes text and raw file bodies without pretending they are JSON", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    await executeRunnerApi(
      {
        operationId: createProject,
        body: "plain text",
        contentType: "text/plain",
      },
      context,
      io(request),
    );
    expect(request.mock.calls[0][1]?.body).toBe("plain text");
    await executeRunnerApi(
      {
        operationId: createProject,
        files: [{ path: "sample.bin" }],
        contentType: "application/octet-stream",
      },
      context,
      io(request),
    );
    expect(
      Buffer.from(request.mock.calls[1][1]?.body as Uint8Array).toString(),
    ).toBe("test");
    await expect(
      executeRunnerApi(
        {
          operationId: createProject,
          body: "unexpected",
          files: [{ artifactId: "a" }],
          contentType: "application/octet-stream",
        },
        context,
        io(request),
      ),
    ).rejects.toThrow();
  });
  it("keeps protocol clients separate from REST dispatch", () => {
    const protocols = runnerApiCatalog().filter(operation => operation.transport === "protocol");
    expect(protocols.some(operation => operation.path.endsWith("/events/ws"))).toBe(true);
    for (const operation of protocols) {
      expect(() => validateRunnerApiCall({ operationId: operation.operationId }, context)).toThrow("protocol client");
    }
  });
  it("keeps skill-test mode consistent with the advertised tool contract", () => {
    expect(
      validateRunnerApiCall(
        { operationId: createProject, body: { name: "Skill fixture" } },
        { ...context, workMode: "skill_test" },
      ).operation.method,
    ).toBe("POST");
  });
  it("passes uploaded JSON bodies through the same route validation as REST", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Board access required" }, { status: 403 }));
    const transport = io(request);
    transport.readFile = async () => ({ bytes: Buffer.from('{"status":"idle"}'), filename: "update.json", contentType: "application/json" });
    expect(await executeRunnerApi({ operationId: "PATCH /api/agents/{id}", pathParams: { id: "fixture" }, files: [{ path: "update.json" }], contentType: "application/json" }, context, transport))
      .toMatchObject({ ok: false, status: 403 });
    expect(Buffer.from(request.mock.calls[0][1]?.body as Uint8Array).toString()).toBe('{"status":"idle"}');
  });
  it("reads text windows from a live response and supplies stable snapshots", async () => {
    const text = "prefix\n" + "🧭é\n".repeat(6000) + "END-OF-EVIDENCE";
    const saveResponse = vi.fn(io(fetch).saveResponse);
    const request = vi.fn<typeof fetch>(async () => new Response(text, { headers: { "content-type": "application/json", etag: '"content-identity"' } }));
    let offsetBytes = 0;
    let received = "";
    do {
      const result = await executeRunnerApi({ operationId: projects, responseText: { offsetBytes, limitBytes: 4096 } }, context, { ...io(request), saveResponse }) as any;
      expect(result).toMatchObject({ ok: true, etag: '"content-identity"', responseText: { offsetBytes, totalBytes: Buffer.byteLength(text) } });
      expect(Buffer.byteLength(result.data)).toBeLessThanOrEqual(4096);
      received += result.data;
      offsetBytes = result.responseText.nextOffsetBytes;
    } while (offsetBytes !== null);
    expect(received).toBe(text);
    expect(saveResponse).toHaveBeenCalled();
    expect(request.mock.calls.every(([, options]) => new Headers(options?.headers).get("Authorization") === "Bearer private-agent-token")).toBe(true);
  });
  it.each(["text/plain", "application/octet-stream"])("does not duplicate an unpaged multi-gigabyte asset (%s)", async contentType => {
    const totalBytes = 3 * 1024 * 1024 * 1024;
    const saveResponse = vi.fn(io(fetch).saveResponse);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=0-24576");
      return new Response(Buffer.alloc(24577, 65), { status: 206, headers: {
        "content-type": contentType, "content-range": `bytes 0-24576/${totalBytes}`, etag: `"${"a".repeat(64)}"`,
      } });
    });
    const result = await executeRunnerApi({ operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: "existing" } }, context, { ...io(request), saveResponse });
    expect(result).toMatchObject({ ok: true, status: 206, byteSize: totalBytes, artifact: { artifactId: "existing", byteSize: totalBytes, sha256: "a".repeat(64) } });
    expect(saveResponse).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reads a page beyond ten MiB in a multi-gigabyte asset", async () => {
    const offsetBytes = 3 * 1024 * 1024 * 1024;
    const totalBytes = offsetBytes + 100;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe(`bytes=${offsetBytes - 1}-${offsetBytes + 4}`);
      return new Response("abcdef", { status: 206, headers: {
        "content-type": "text/plain", "content-range": `bytes ${offsetBytes - 1}-${offsetBytes + 4}/${totalBytes}`,
      } });
    });
    expect(await executeRunnerApi({ operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: "large" }, responseText: { offsetBytes, limitBytes: 4 } }, context, io(request))).toMatchObject({
      ok: true, data: "bcde", responseText: { offsetBytes, nextOffsetBytes: offsetBytes + 4, totalBytes },
    });
  });
  it.each([true, false])("saves responses above ten MiB (known length: %s)", async knownLength => {
    const bytes = Buffer.alloc(12 * 1024 * 1024, 65);
    const request = vi.fn<typeof fetch>(async () => new Response(bytes, { headers: {
      "content-type": "text/plain", ...(knownLength ? { "content-length": String(bytes.length) } : {}),
    } }));
    const result = await executeRunnerApi({ operationId: projects }, context, io(request));
    expect(result).toMatchObject({ ok: true, artifact: { byteSize: bytes.length }, byteSize: bytes.length });
  });
  it("pages a twelve MiB asset with linear transfer and UTF-8 boundaries", async () => {
    const bytes = Buffer.from("🧭é".repeat(Math.floor(12 * 1024 * 1024 / 6)));
    let transferred = 0;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const range = new Headers(init?.headers).get("range");
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
      if (!match) { transferred += bytes.length; return new Response(bytes, { headers: { "content-type": "text/plain" } }); }
      const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
      const part = bytes.subarray(start, end + 1); transferred += part.length;
      return new Response(part, { status: 206, headers: { "content-type": "text/plain", "content-range": `bytes ${start}-${end}/${bytes.length}` } });
    });
    let offsetBytes: number | null = 0;
    const parts: string[] = [];
    do {
      const page: any = await executeRunnerApi({ operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: "large" }, responseText: { offsetBytes } }, context, io(request));
      expect(page.ok).toBe(true);
      parts.push(page.data); offsetBytes = page.responseText.nextOffsetBytes;
    } while (offsetBytes !== null);
    expect(parts.join("")).toBe(bytes.toString());
    expect(transferred).toBeLessThan(bytes.length + request.mock.calls.length * 5);
    expect(request.mock.calls.every(([, init]) => new Headers(init?.headers).has("range"))).toBe(true);
  });
  it.each([
    ["bytes 4-8/20", "12345"], // wrong start
    ["bytes 3-7/20", "12345"], // early end
    ["bytes 3-8/20", "12345"], // truncated body
    ["bytes 3-8/9007199254740992", "123456"], // imprecise total
    ["bytes 3-8/*", "123456"], // unknown total
    [null, "123456"],
  ])("rejects inconsistent partial asset receipts: %s", async (range, body) => {
    const result = await executeRunnerApi({ operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: "saved" }, responseText: { offsetBytes: 4, limitBytes: 4 } }, context, io(async () => new Response(body, { status: 206, headers: { "content-type": "text/plain", ...(range ? { "content-range": range } : {}) } })));
    expect(result).toMatchObject({ ok: false, error: "response_text_invalid_range" });
  });
  it("accepts EOF and rejects an offset inside a UTF-8 code point in ranged assets", async () => {
    const call = (offsetBytes: number, bytes: Buffer, range: string) => executeRunnerApi({ operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: "saved" }, responseText: { offsetBytes, limitBytes: 4 } }, context, io(async () => new Response(new Uint8Array(bytes), { status: 206, headers: { "content-type": "text/plain", "content-range": range } })));
    expect(await call(2, Buffer.from([0xa9]), "bytes 1-1/2")).toMatchObject({ ok: true, data: "", responseText: { nextOffsetBytes: null, totalBytes: 2 } });
    expect(await call(1, Buffer.from("é"), "bytes 0-1/2")).toMatchObject({ ok: false, error: "response_text_invalid_offset" });
  });
  it("does not silently accept an asset server that ignores the byte range", async () => {
    const result = await executeRunnerApi({ operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: "saved" }, responseText: { limitBytes: 4 } }, context, io(async () => new Response("unbounded", { headers: { "content-type": "text/plain" } })));
    expect(result).toMatchObject({ ok: false, error: "api_transport_failure" });
  });
  it.each([{ offsetBytes: -1 }, { limitBytes: 0 }, { limitBytes: 3 }, { limitBytes: 24577 }, { offsetBytes: 0.5 }, { offsetBytes: Number.MAX_SAFE_INTEGER + 1 }])("rejects invalid text windows before dispatch: %j", async responseText => {
    const request = vi.fn<typeof fetch>();
    await expect(executeRunnerApi({ operationId: projects, responseText }, context, io(request))).rejects.toThrow("Invalid call_api arguments");
    expect(request).not.toHaveBeenCalled();
  });
  it("does not page mutation responses by repeating the mutation", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(executeRunnerApi({ operationId: createProject, body: { name: "Once" }, responseText: {} }, context, io(request))).rejects.toThrow("GET");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects binary, invalid UTF-8 and offsets that split text", async () => {
    for (const [body, type, offsetBytes] of [
      [Buffer.from("binary"), "application/octet-stream", 0],
      [Buffer.from([0xff]), "text/plain", 0],
      [Buffer.concat([Buffer.from([0xc2]), Buffer.alloc(24576, 0x80)]), "text/plain", 0],
      [Buffer.from("é"), "text/plain", 1],
      [Buffer.from("short"), "text/plain", 6],
    ] as const) {
      const saveResponse = vi.fn(io(fetch).saveResponse);
      const result = await executeRunnerApi({ operationId: projects, responseText: { offsetBytes } }, context, { ...io(async () => new Response(body, { headers: { "content-type": type } })), saveResponse });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("response_text") });
      expect(saveResponse).not.toHaveBeenCalled();
    }
  });
  it("preserves denials for bounded text reads", async () => {
    expect(await executeRunnerApi({ operationId: projects, responseText: {} }, context, io(async () => Response.json({ error: "denied" }, { status: 403 })))).toMatchObject({ ok: false, status: 403, data: '{"error":"denied"}' });
  });
  it("bounds streamed responses even without content-length", async () => {
    await expect(
      readBoundedResponse(new Response("too large"), 3),
    ).rejects.toThrow("transfer limit");
  });
});
