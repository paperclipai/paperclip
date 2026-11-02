import { describe, expect, it, vi } from "vitest";
import { appDefinitionSchema } from "@paperclipai/shared";
import { HttpError } from "../../../errors.js";
import sourceDefinition from "../../../../../scripts/app-definition-overrides/supabase.json" with { type: "json" };
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";
import { validateToolContent } from "../../tool-content-guards.js";
import { SUPABASE_API_URL, SUPABASE_METHOD, SUPABASE_TOOLS, isCurrentSupabaseCatalogEntry,
  isSupabaseConnection, supabaseClient, supabaseRisk } from "./index.js";

const projectRef = "abcdefghijklmnopqrst";
const definition = appDefinitionSchema.parse(sourceDefinition);
const token = "sbp_supabase-canary-never-log";
const headers = { Authorization: `Bearer ${token}` };
const deployment = { slug: "hello", entrypoint_path: "index.ts", files: [{ name: "index.ts", content: "Deno.serve(() => new Response('hello'))" }] };
async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try { await promise; }
  catch (error) { if (error instanceof HttpError) return error; throw error; }
  throw new Error("Expected a failed provider request");
}

describe("Supabase deployment and configuration", () => {
  it("keeps account MCP setup optional and requires a native deployment project", () => {
    expect(appDefinitionSchema.safeParse(definition).success).toBe(true);
    for (const method of definition.methods.filter(method => method.transport === "mcp_remote")) {
      expect(method.tenantFields?.find(field => field.key === "projectRef")).toMatchObject({ advanced: true });
      expect(method.tenantFields?.find(field => field.key === "projectRef")?.required).not.toBe(true);
      expect(method.tenantFields?.find(field => field.key === "readOnly")?.defaultValue).toBe(false);
    }
    expect(definition.methods.find(method => method.key === SUPABASE_METHOD)).toMatchObject({
      transport: "rest_api", auth: "api_key", defaults: { serverUrl: SUPABASE_API_URL },
      tenantFields: [expect.objectContaining({ key: "projectRef", required: true })],
    });
  });

  it("requires the reviewed REST endpoint and rejects stale risk or schema contracts", () => {
    const connection = { transport: "rest_api", config: { sourceTemplateKey: "supabase", connectionMethodKey: SUPABASE_METHOD, url: SUPABASE_API_URL } };
    expect(isSupabaseConnection(connection)).toBe(true);
    expect(isSupabaseConnection({ ...connection, config: { ...connection.config, url: "https://attacker.example" } })).toBe(false);
    for (const tool of SUPABASE_TOOLS) {
      const entry = { toolName: tool.name, schemaHash: stableHash(tool.inputSchema), versionHash: descriptorHash(tool, supabaseRisk(tool.name)), riskLevel: supabaseRisk(tool.name) };
      expect(isCurrentSupabaseCatalogEntry(entry)).toBe(true);
      expect(isCurrentSupabaseCatalogEntry({ ...entry, schemaHash: "stale" })).toBe(false);
      expect(isCurrentSupabaseCatalogEntry({ ...entry, riskLevel: "unknown" })).toBe(false);
    }
    expect(supabaseRisk("supabase_deploy_edge_function")).toBe("write");
    expect(supabaseRisk("supabase_delete_edge_function")).toBe("destructive");
    expect(supabaseRisk("unknown_action")).toBe("destructive");
    expect(SUPABASE_TOOLS.find(tool => tool.name === "supabase_deploy_edge_function")?.inputSchema.required).not.toContain("verify_jwt");
  });

  it("pins every request to the saved project and sends only selected credential headers", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${SUPABASE_API_URL}/projects/${projectRef}`);
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("Authorization")).toBe(headers.Authorization);
      expect(new Headers(init.headers).get("X-Unrelated-Secret")).toBeNull();
      return Response.json({ ref: projectRef, name: "Fixture", database: { password: "hidden" }, secret: token });
    });
    const client = supabaseClient({ ...headers, "X-Unrelated-Secret": "not-forwarded" }, request, projectRef);
    expect(await client.probe()).toEqual({ ref: projectRef, name: "Fixture" });
    await expect(client.invoke("supabase_get_project", { projectRef: "different-project" })).rejects.toMatchObject({ status: 422 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => supabaseClient(headers, request, "../foreign")).toThrow("project reference");
  });

  it("deploys in-memory source files with matching multipart metadata", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${SUPABASE_API_URL}/projects/${projectRef}/functions/deploy?slug=hello`);
      expect(init.method).toBe("POST");
      expect(Buffer.isBuffer(init.body)).toBe(true);
      const form = await new Response(init.body, { headers: init.headers }).formData();
      expect(JSON.parse(String(form.get("metadata")))).toEqual({ name: "hello", entrypoint_path: "index.ts", verify_jwt: true });
      const files = form.getAll("file") as File[];
      expect(files.map(file => file.name)).toEqual(["index.ts"]);
      expect(await files[0].text()).toBe(deployment.files[0].content);
      return Response.json({ slug: "hello", status: "ACTIVE", version: 1, verify_jwt: true, credentials: { token } });
    });
    expect(await supabaseClient(headers, request, projectRef).invoke("supabase_deploy_edge_function", deployment))
      .toEqual({ slug: "hello", status: "ACTIVE", version: 1, verify_jwt: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit function authentication choice and import map", async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const form = await new Response(init.body, { headers: init.headers }).formData();
      expect(JSON.parse(String(form.get("metadata")))).toMatchObject({ verify_jwt: false, import_map_path: "deno.json" });
      expect(form.getAll("file")).toHaveLength(2);
      return Response.json({ slug: "hello", verify_jwt: false });
    });
    await supabaseClient(headers, request, projectRef).invoke("supabase_deploy_edge_function", {
      ...deployment, verify_jwt: false, import_map_path: "deno.json", files: [...deployment.files, { name: "deno.json", content: "{}" }],
    });
  });

  it.each([
    { ...deployment, files: [{ name: "../index.ts", content: "bad" }] },
    { ...deployment, entrypoint_path: "missing.ts" },
    { ...deployment, import_map_path: "missing.json" },
    { ...deployment, files: [...deployment.files, ...deployment.files] },
    { ...deployment, slug: "../other-project" },
    { ...deployment, files: [{ name: "/etc/passwd", content: "bad" }] },
  ])("rejects invalid source/path inputs before network access", async args => {
    const request = vi.fn();
    await expect(supabaseClient(headers, request, projectRef).invoke("supabase_deploy_edge_function", args)).rejects.toMatchObject({ status: 422 });
    expect(request).not.toHaveBeenCalled();
  });

  it("projects reviewed Auth/Data API fields and strips provider secrets from read and write results", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/config/auth")) {
        if (init.method === "PATCH") expect(JSON.parse(init.body as string)).toEqual({ site_url: "https://fixture.example", uri_allow_list: "https://fixture.example/**" });
        return Response.json({ site_url: "https://fixture.example", smtp_pass: "smtp-canary", external_github_secret: "oauth-canary", jwt_secret: "jwt-canary", uri_allow_list: token });
      }
      expect(url).toBe(`${SUPABASE_API_URL}/projects/${projectRef}/postgrest`);
      if (init.method === "PATCH") expect(JSON.parse(init.body as string)).toEqual({ db_schema: "public", max_rows: 1000 });
      return Response.json({ db_schema: "public", max_rows: 1000, jwt_secret: "jwt-canary" });
    });
    const client = supabaseClient(headers, request, projectRef);
    for (const [name, args] of [
      ["supabase_get_auth_config", {}],
      ["supabase_update_auth_config", { config: { site_url: "https://fixture.example", uri_allow_list: "https://fixture.example/**" } }],
    ] as const) expect(await client.invoke(name, args)).toEqual({ site_url: "https://fixture.example", uri_allow_list: "[REDACTED]" });
    for (const [name, args] of [
      ["supabase_get_api_config", {}], ["supabase_update_api_config", { config: { db_schema: "public", max_rows: 1000 } }],
    ] as const) expect(await client.invoke(name, args)).toEqual({ db_schema: "public", max_rows: 1000 });
    await expect(client.invoke("supabase_update_auth_config", { config: { smtp_pass: "must-not-send" } })).rejects.toMatchObject({ status: 422 });
    await expect(client.invoke("supabase_update_auth_config", { config: {} })).rejects.toMatchObject({ status: 422 });
    await expect(client.invoke("supabase_update_api_config", { config: { jwt_secret: "must-not-send" } })).rejects.toMatchObject({ status: 422 });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("lists, inspects and deletes functions without leaking unreviewed provider fields", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => init.method === "DELETE" ? new Response(null, { status: 204 })
      : Response.json(url.endsWith("/functions") ? [{ slug: "hello", status: "ACTIVE", access_token: token }] : { slug: "hello", status: "ACTIVE", environment: { SECRET: "hidden" } }));
    const client = supabaseClient(headers, request, projectRef);
    expect(await client.invoke("supabase_list_edge_functions", {})).toEqual([{ slug: "hello", status: "ACTIVE" }]);
    expect(await client.invoke("supabase_get_edge_function", { slug: "hello" })).toEqual({ slug: "hello", status: "ACTIVE" });
    expect(await client.invoke("supabase_delete_edge_function", { slug: "hello" })).toEqual({ deleted: true, slug: "hello" });
    expect(request.mock.calls[2][0]).toBe(`${SUPABASE_API_URL}/projects/${projectRef}/functions/hello`);
  });

  it("configures function secrets, omits values from inventory, and redacts argument summaries", async () => {
    const secretValue = "application-secret-canary";
    const parameters = { name: "APP_KEY", secretValue };
    const guarded = await validateToolContent({ value: parameters, direction: "arguments", sensitiveMode: "redact", promptInjectionMode: "ignore" });
    expect(JSON.stringify(guarded)).not.toContain(secretValue);
    expect(guarded.value).toMatchObject({ name: "APP_KEY", secretValue: expect.any(String) });
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${SUPABASE_API_URL}/projects/${projectRef}/secrets`);
      if (init.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual([{ name: "APP_KEY", value: secretValue }]);
        return Response.json({ name: secretValue, value: secretValue, [token]: secretValue });
      }
      return Response.json([{ name: "APP_KEY", updated_at: "2026-10-22T00:00:00Z", value: secretValue, digest: secretValue, unexpected: token }]);
    });
    const client = supabaseClient(headers, request, projectRef);
    expect(await client.invoke("supabase_upsert_edge_function_secret", parameters)).toEqual({ configured: true, name: "APP_KEY" });
    // An explicit second invocation dispatches once again; the client performs
    // no hidden automatic retry, reads, or extra verification requests.
    expect(await client.invoke("supabase_upsert_edge_function_secret", parameters)).toEqual({ configured: true, name: "APP_KEY" });
    expect(await client.invoke("supabase_list_edge_function_secrets", {})).toEqual([{ name: "APP_KEY", updated_at: "2026-10-22T00:00:00Z" }]);
    expect(request).toHaveBeenCalledTimes(3);
    await expect(client.invoke("supabase_upsert_edge_function_secret", { name: "APP_KEY", secretValue: "x".repeat(65537) })).rejects.toMatchObject({ status: 422 });
    await expect(client.invoke("supabase_upsert_edge_function_secret", { ...parameters, projectRef: "other" })).rejects.toMatchObject({ status: 422 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not return or retry a provider error containing an application secret", async () => {
    const secretValue = "application-secret-canary";
    const request = vi.fn(async () => new Response(secretValue, { status: 400 }));
    const result = await failure(supabaseClient(headers, request, projectRef).invoke("supabase_upsert_edge_function_secret", { name: "APP_KEY", secretValue }));
    expect(result.status).toBe(400);
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(result.message).not.toContain(secretValue);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402, 403, 404, 409, 422, 429, 500, 302])("does not echo provider error bodies or follow redirects (%i)", async status => {
    const request = vi.fn(async () => new Response(`upstream ${token}`, { status, headers: { Location: "https://attacker.example" } }));
    const result = await failure(supabaseClient(headers, request, projectRef).probe());
    expect(result.status).toBe(status >= 500 || status === 302 ? 502 : status);
    expect(result.message).not.toContain(token);
    expect(JSON.stringify(result.details)).not.toContain(token);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous deployment", async () => {
    const request = vi.fn(async () => { throw new Error(`transport ${token}`); });
    await expect(supabaseClient(headers, request, projectRef).invoke("supabase_deploy_edge_function", deployment))
      .rejects.toMatchObject({ status: 502, details: { code: "supabase_outcome_unknown" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "body"])("does not expose an untrusted HttpError from the %s", async stage => {
    const untrusted = new HttpError(504, `provider error ${token}`, { code: "supabase_deadline_exceeded", token });
    const request = vi.fn(async () => {
      if (stage === "transport") throw untrusted;
      return new Response(new ReadableStream({ pull(controller) { controller.error(untrusted); } }));
    });
    const result = await failure(supabaseClient(headers, request, projectRef).probe());
    expect(result).toMatchObject({ status: 502, details: { code: "supabase_outcome_unknown" } });
    expect(result).not.toBe(untrusted);
    expect(result.message).not.toContain(token);
    expect(JSON.stringify(result.details)).not.toContain(token);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats a provider server error after an applied configuration write as uncertain", async () => {
    let maxRows = 901;
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") {
        maxRows = JSON.parse(String(init.body)).max_rows;
        return new Response(`restart failed ${token}`, { status: 500 });
      }
      return Response.json({ max_rows: maxRows });
    });
    const client = supabaseClient(headers, request, projectRef);
    const result = await failure(client.invoke("supabase_update_api_config", { config: { max_rows: 1000 } }));
    expect(result).toMatchObject({ status: 502, details: { code: "supabase_outcome_unknown" } });
    expect(result.message).toContain("inspect its state before retrying");
    expect(result.message).not.toContain(token);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await client.invoke("supabase_get_api_config", {})).toEqual({ max_rows: 1000 });
    expect(request.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });

  it("bounds a stalled body reader without blocking an unrelated request", async () => {
    const controller = new AbortController();
    const slow = supabaseClient(headers, async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })), projectRef, controller.signal, Date.now() + 20);
    const pending = slow.probe();
    expect(await supabaseClient(headers, async () => Response.json({ ref: projectRef }), projectRef).probe()).toEqual({ ref: projectRef });
    await expect(pending).rejects.toMatchObject({ status: 504 });
  });

  it("bounds a transport that ignores cancellation and rejects already-aborted dispatch", async () => {
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<Response>(() => {}));
    const client = supabaseClient(headers, request, projectRef, controller.signal, Date.now() + 20);
    await expect(client.probe()).rejects.toMatchObject({ status: 504 });
    expect(request).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(client.invoke("supabase_delete_edge_function", { slug: "hello" })).rejects.toMatchObject({ status: 504 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves a fired local deadline when wall-clock time is still before its threshold", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const controller = new AbortController();
      const request = vi.fn(() => new Promise<Response>(() => {}));
      const client = supabaseClient(headers, request, projectRef, controller.signal, 1_020);
      const pending = expect(client.probe()).rejects.toMatchObject({
        status: 504, details: { code: "supabase_deadline_exceeded" },
      });
      await vi.advanceTimersByTimeAsync(20);
      await pending;
      expect(Date.now()).toBeLessThan(1_020);
      expect(controller.signal.aborted).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects oversized output and invalid JSON without exposing response bytes", async () => {
    for (const response of [() => new Response("x".repeat(2 * 1024 * 1024 + 1)), () => new Response(token)]) {
      const result = await failure(supabaseClient(headers, async () => response(), projectRef).probe());
      expect(result.status).toBe(502);
      expect(result.message).not.toContain(token);
    }
  });
});
