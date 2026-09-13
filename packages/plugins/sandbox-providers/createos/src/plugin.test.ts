import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlugin } from "./plugin.js";
import { parseConfig } from "./config.js";
import manifest from "./manifest.js";
import { execute } from "./execute.js";
import { CreateosClient } from "./client.js";
vi.mock("./request-pacer.js", () => ({ waitForRequest: vi.fn().mockResolvedValue(undefined) }));

const config = { apiUrl: "https://createos.example.test", apiKey: "test-secret", shape: "test-shape", timeoutMs: 5000 };
const base = { driverKey: "createos", companyId: "company-a", environmentId: "env-a", config };
const success = (data: unknown = {}) => Response.json({ status: "success", data });
const failure = (status: number) => Response.json({ status: "fail", data: "private provider diagnostics test-secret" }, { status });
const data = (seq: number, text: string | Buffer, stream = "stdout") => ({ type: "data", seq, stream, data_base64: Buffer.from(text).toString("base64") });
const ndjson = (frames: unknown[]) => new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n", {
  headers: { "Content-Type": "application/x-ndjson" },
});

type Call = { path: string; method: string; body: Record<string, unknown>; init: RequestInit };
function provider() {
  const calls: Call[] = [];
  let state = "running";
  let marker = "";
  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    const method = init.method ?? "GET";
    const raw = typeof init.body === "string" ? init.body : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : {};
    calls.push({ path, method, body, init });
    expect(init.headers).toMatchObject({ "X-Api-Key": "test-secret" });
    expect(init.redirect).toBe("error");
    if (path === "/v1/sandboxes" && method === "POST") return success({ id: "sb_test" });
    if (path === "/v1/sandboxes/sb_test" && method === "GET") return success({ id: "sb_test", status: state });
    if (path === "/v1/sandboxes/sb_test" && method === "DELETE") { state = "destroyed"; return success({ id: "sb_test" }); }
    if (path.endsWith("/pause")) { state = "paused"; return success({ status: "pausing" }); }
    if (path.endsWith("/resume")) { state = "running"; return success({ status: "resuming" }); }
    if (parsed.pathname.endsWith("/files") && method === "PUT") {
      if (parsed.searchParams.get("path")?.endsWith(".paperclip-createos-lease")) marker = raw;
      return success();
    }
    if (path.endsWith("/exec")) return success({ result: { exit_code: 0, stdout: body.cmd === "/bin/cat" ? marker : "", stderr: "" } });
    if (path.endsWith("/processes") && method === "POST") {
      // These sandboxes declare no creation-time env keys. Match the real
      // provider's rejection of undeclared API-level overrides.
      if (Object.keys((body.env ?? {}) as object).length) return failure(400);
      return success({ process_id: "proc_test" });
    }
    if (path.endsWith("/stdin/close")) return success();
    if (parsed.pathname.endsWith("/connect")) return ndjson([data(1, "paperclip-createos-ready\n"), { type: "exit", exit_code: 0 }]);
    if (method === "DELETE" && path.includes("/processes/")) return success({ tree_exited: true });
    throw new Error(`Unhandled fixture request ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, setState: (value: string) => { state = value; }, setMarker: (value: string) => { marker = value; } };
}

function executionParams(overrides = {}) {
  return { ...base, lease: { providerLeaseId: "sb_test" }, command: "echo", args: ["hello"], ...overrides };
}

beforeEach(() => { vi.stubEnv("CREATEOS_API_KEY", ""); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("CreateOS lifecycle", () => {
  it("acquires, executes, realizes, pauses, resumes, and destroys using public API envelopes", async () => {
    const fake = provider();
    const hooks = createPlugin().definition;
    const params = { ...base, config: { ...config, reuseLease: true, rootfs: "tpl_ready", region: "us" } };
    const lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "run-a" });
    expect(fake.calls[0].body).toEqual({ shape: "test-shape", rootfs: "tpl_ready", region: "us", ingress_enabled: false });
    expect(JSON.stringify(lease)).not.toContain("test-secret");
    expect(await hooks.onEnvironmentRealizeWorkspace!({ ...params, lease, workspace: { localPath: "/private/host/path" } })).toMatchObject({ cwd: "/paperclip-workspace" });
    expect(await hooks.onEnvironmentExecute!({ ...params, lease, command: "echo" })).toMatchObject({ exitCode: 0, timedOut: false });
    await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    expect(fake.calls.some((call) => call.path.endsWith("/pause"))).toBe(true);
    expect(await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata })).toMatchObject({ providerLeaseId: "sb_test" });
    await hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/sandboxes/sb_test" });
  });

  it("cleans up failed acquisition and never hides delete failure", async () => {
    const fake = provider();
    const normal = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (url, init) => String(url).endsWith("/exec") ? failure(503) : normal(url, init));
    await expect(createPlugin().definition.onEnvironmentAcquireLease!({ ...base, runId: "run" })).rejects.toThrow("HTTP 503");
    expect(fake.calls.at(-1)?.method).toBe("DELETE");
    fake.fetchMock.mockImplementation(async (url, init) => init?.method === "DELETE" ? failure(500) : String(url).endsWith("/exec") ? failure(503) : normal(url, init));
    await expect(createPlugin().definition.onEnvironmentAcquireLease!({ ...base, runId: "run" })).rejects.toThrow("cleanup is unconfirmed");
  });

  it("rejects guaranteed-expiry leases before provisioning", async () => {
    const fake = provider();
    await expect(createPlugin().definition.onEnvironmentAcquireLease!({ ...base, runId: "login", requestedExpiresAt: "2026-09-08T12:00:00Z" })).rejects.toThrow("guaranteed expiration");
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it("does not execute, resume, or destroy another company's recorded lease", async () => {
    const fake = provider();
    const hooks = createPlugin().definition;
    const lease = await hooks.onEnvironmentAcquireLease!({ ...base, runId: "run" });
    fake.fetchMock.mockClear();
    const other = { ...base, companyId: "company-b" };
    await expect(hooks.onEnvironmentExecute!({ ...other, lease, command: "echo" })).rejects.toThrow("this environment");
    await expect(hooks.onEnvironmentResumeLease!({ ...other, providerLeaseId: "sb_test", leaseMetadata: lease.metadata })).rejects.toThrow("this environment");
    await expect(hooks.onEnvironmentDestroyLease!({ ...other, providerLeaseId: "sb_test", leaseMetadata: lease.metadata })).rejects.toThrow("this environment");
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it("expires a missing or mismatched workspace but preserves transient resume failures", async () => {
    const fake = provider();
    const hooks = createPlugin().definition;
    const lease = await hooks.onEnvironmentAcquireLease!({ ...base, runId: "run" });
    fake.setMarker("wrong");
    const params = { ...base, providerLeaseId: "sb_test", leaseMetadata: lease.metadata };
    expect(await hooks.onEnvironmentResumeLease!(params)).toMatchObject({ providerLeaseId: null });
    fake.fetchMock.mockResolvedValueOnce(failure(404));
    expect(await hooks.onEnvironmentResumeLease!(params)).toMatchObject({ providerLeaseId: null });
    fake.fetchMock.mockResolvedValueOnce(failure(503));
    await expect(hooks.onEnvironmentResumeLease!(params)).rejects.toThrow("HTTP 503");
    expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("does not POST pause/resume when already in the desired state", async () => {
    const fake = provider();
    const client = new CreateosClient(parseConfig(config));
    await client.transition("sb_test", "running", AbortSignal.timeout(5000));
    fake.setState("paused");
    await client.transition("sb_test", "paused", AbortSignal.timeout(5000));
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("expires a reusable lease when its requested image or shape changes", async () => {
    const fake = provider();
    const hooks = createPlugin().definition;
    const lease = await hooks.onEnvironmentAcquireLease!({ ...base, runId: "run" });
    fake.fetchMock.mockClear();
    for (const changed of [{ shape: "larger" }, { rootfs: "new-template" }, { region: "other" }]) {
      expect(await hooks.onEnvironmentResumeLease!({
        ...base, config: { ...config, ...changed }, providerLeaseId: "sb_test", leaseMetadata: lease.metadata,
      })).toMatchObject({ providerLeaseId: null });
    }
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it("probes actual process execution and always deletes the sandbox", async () => {
    const fake = provider();
    expect(await createPlugin().definition.onEnvironmentProbe!(base)).toMatchObject({ ok: true });
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/sandboxes/sb_test" });
  });

  it("aborts an active command and waits for tree cleanup before pausing", async () => {
    const fake = provider();
    const hooks = createPlugin().definition;
    const params = { ...base, config: { ...config, reuseLease: true } };
    const lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "run" });
    const normal = fake.fetchMock.getMockImplementation()!;
    let streaming!: () => void;
    const ready = new Promise<void>((resolve) => { streaming = resolve; });
    fake.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/connect?")) return new Response(new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
          streaming();
        },
      }));
      return normal(url, init);
    });
    const command = hooks.onEnvironmentExecute!({ ...params, lease, command: "sleep", args: ["60"] });
    const rejected = expect(command).rejects.toThrow("cancelled");
    await ready;
    await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId: "sb_test", leaseMetadata: lease.metadata });
    await rejected;
    const stop = fake.calls.findIndex((call) => call.method === "DELETE" && call.path.includes("/processes/"));
    const pause = fake.calls.findIndex((call) => call.path.endsWith("/pause"));
    expect(stop).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(stop);
  });

  it("blocks reuse after ambiguous process creation until the sandbox is destroyed", async () => {
    const fake = provider();
    const hooks = createPlugin().definition;
    const params = { ...base, config: { ...config, reuseLease: true } };
    const lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "run" });
    const normal = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (url, init) => String(url).endsWith("/processes") ? failure(502) : normal(url, init));
    await expect(hooks.onEnvironmentExecute!({ ...params, lease, command: "sleep" })).rejects.toThrow("creation could not be confirmed");
    await expect(hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId: "sb_test", leaseMetadata: lease.metadata })).rejects.toThrow("cleanup is unconfirmed");
    expect(fake.calls.some((call) => call.path.endsWith("/pause"))).toBe(false);
    await hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId: "sb_test", leaseMetadata: lease.metadata });
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/sandboxes/sb_test" });
  });

  it("waits for asynchronous provider transitions rather than treating 202 as completion", async () => {
    const fake = provider();
    const normal = fake.fetchMock.getMockImplementation()!;
    let reads = 0;
    fake.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/sb_test") && (!init?.method || init.method === "GET")) {
        reads++;
        return success({ id: "sb_test", status: reads === 1 ? "paused" : reads === 2 ? "resuming" : "running" });
      }
      return normal(url, init);
    });
    await new CreateosClient(parseConfig(config)).transition("sb_test", "running", AbortSignal.timeout(5000));
    expect(reads).toBe(3);
    expect(fake.calls.filter((call) => call.path.endsWith("/resume"))).toHaveLength(1);
  });
});

describe("CreateOS command protocol", () => {
  it("quotes hostile args/env/cwd and stages stdin instead of racing the input endpoint", async () => {
    const fake = provider();
    const result = await execute(new CreateosClient(parseConfig(config)), executionParams({
      command: "printf", args: ["a'; touch /bad; echo '"], cwd: "/work dir",
      env: { MESSAGE: "$(touch /bad)" }, stdin: "secret input\n",
    }), AbortSignal.timeout(5000));
    expect(result.exitCode).toBe(0);
    const create = fake.calls.find((call) => call.path.endsWith("/processes"))!;
    expect(create.body).toMatchObject({ cmd: "/bin/bash", cwd: "/work dir" });
    expect(create.body).not.toHaveProperty("env");
    expect((create.body.args as string[])[1]).toContain("MESSAGE='$(touch /bad)'");
    expect((create.body.args as string[])[1]).toContain("'a'\"'\"'; touch /bad; echo '\"'\"''");
    expect((create.body.args as string[])[1]).not.toContain("secret input");
    expect(fake.calls.some((call) => call.path.endsWith("/input"))).toBe(false);
    expect(fake.calls.at(-1)?.body).toMatchObject({ cmd: "/bin/rm" });
  });

  it("replays the same process after disconnect without duplicate logs, preserving split UTF-8", async () => {
    const fake = provider();
    const normal = fake.fetchMock.getMockImplementation()!;
    let connects = 0;
    const euro = Buffer.from("€");
    fake.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/connect?")) {
        connects++;
        if (connects === 1) return ndjson([data(1, euro.subarray(0, 1))]);
        expect(String(url)).toContain("after=1");
        return ndjson([data(1, euro.subarray(0, 1)), data(2, euro.subarray(1)), data(3, "warning", "stderr"), { type: "exit", exit_code: 7 }]);
      }
      return normal(url, init);
    });
    const log = vi.fn();
    const result = await execute(new CreateosClient(parseConfig(config)), executionParams(), AbortSignal.timeout(5000), log);
    expect(result).toMatchObject({ exitCode: 7, stdout: "€", stderr: "warning", timedOut: false });
    expect(log.mock.calls).toEqual([["stdout", "€"], ["stderr", "warning"]]);
    expect(fake.calls.filter((call) => call.path.endsWith("/processes") && call.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["gap", () => ndjson([data(2, "lost")])],
    ["expired", () => failure(410)],
    ["stream error", () => ndjson([{ type: "error", error: "output_offset_expired" }])],
    ["malformed", () => new Response("{broken\n")],
    ["missing exit status", () => ndjson([{ type: "exit" }])],
  ])("terminates the process tree on %s output", async (_name, response) => {
    const fake = provider();
    const normal = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (url, init) => String(url).includes("/connect?") ? response() : normal(url, init));
    await expect(execute(new CreateosClient(parseConfig(config)), executionParams(), AbortSignal.timeout(5000))).rejects.toThrow();
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.includes("/processes/proc_test?grace_ms=1000"))).toBe(true);
  });

  it("enforces timeout and preserves partial output while cleanup uses a fresh deadline", async () => {
    const fake = provider();
    const normal = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/connect?")) return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(data(1, "partial")) + "\n"));
          init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
        },
      }));
      if (init?.method === "DELETE") expect(init.signal?.aborted).toBe(false);
      return normal(url, init);
    });
    const result = await execute(new CreateosClient(parseConfig(config)), executionParams(), AbortSignal.timeout(50));
    expect(result).toMatchObject({ exitCode: null, timedOut: true, stdout: "partial" });
    expect(fake.calls.at(-1)?.method).toBe("DELETE");
  });

  it("reports unconfirmed termination rather than hiding cleanup failure", async () => {
    const fake = provider();
    const normal = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (url, init) => init?.method === "DELETE" ? failure(503) : String(url).includes("/connect?") ? ndjson([{ type: "error" }]) : normal(url, init));
    await expect(execute(new CreateosClient(parseConfig(config)), executionParams(), AbortSignal.timeout(5000))).rejects.toThrow("termination is unconfirmed");
  });

  it("rejects invalid env names before sending a command", async () => {
    const fake = provider();
    await expect(execute(new CreateosClient(parseConfig(config)), executionParams({ env: { "BAD;KEY": "x" } }), AbortSignal.timeout(5000))).rejects.toThrow("Invalid sandbox environment");
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });
});

describe("CreateOS configuration", () => {
  it("normalizes /v1 URLs and keeps the shape explicit", () => {
    expect(parseConfig({ ...config, apiUrl: config.apiUrl + "/v1/" }).apiUrl).toBe(config.apiUrl);
    expect(() => parseConfig({ ...config, shape: "" })).toThrow("shape");
    expect(manifest.environmentDrivers?.[0].supportsLoginPty).not.toBe(true);
  });

  it.each(["https://user:secret@host.test", "https://host.test/?key=secret", "http://remote.test", "file:///tmp/socket", "https://host.test/other"])("rejects unsafe API URL %s", (apiUrl) => {
    expect(() => parseConfig({ ...config, apiUrl })).toThrow("API URL");
  });

  it("supports a local fixture URL and a host-level API key fallback", () => {
    vi.stubEnv("CREATEOS_API_KEY", "fallback");
    expect(new CreateosClient(parseConfig({ ...config, apiUrl: "http://127.0.0.1:3109", apiKey: undefined })).apiKey).toBe("fallback");
    expect(new CreateosClient(parseConfig(config)).apiKey).toBe("test-secret");
  });

  it.each([0, -1, NaN, 1.5, 86_400_001, "500"])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => parseConfig({ ...config, timeoutMs })).toThrow("timeoutMs");
  });

  it("does not expose provider error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(401)));
    await expect(new CreateosClient(parseConfig(config)).getSandbox("sb_test")).rejects.toThrow("HTTP 401");
    await expect(new CreateosClient(parseConfig(config)).getSandbox("sb_test")).rejects.not.toThrow("test-secret");
  });
});
