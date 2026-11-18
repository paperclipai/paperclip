import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboardingConnect, validateOnboardingConnectEvidence, type OnboardingConnectEvidence } from "./onboarding-connect.js";

const origin = "https://tenant.example.test", companyId = "company-1";
const validation = `/api/companies/${companyId}/adapters/paperclip_runner/test-environment`;
const hire = `/api/companies/${companyId}/agent-hires`;
const secret = "PRIVATE_SENTINEL_do_not_retain";
function fixture(options: { ready?: boolean; durationMs?: number; click?: () => Promise<void> | void; wait?: () => Promise<void> } = {}) {
  const events = new EventEmitter();
  let retained!: OnboardingConnectEvidence;
  const page = Object.assign(events, { getByRole(_role: string, { name }: { name: string }) {
    return { click: vi.fn(async () => { expect(name).toBe("Connect"); await options.click?.(); }),
      waitFor: vi.fn(({ timeout }: { timeout: number }) => {
        expect(name).toBe("Get started");
        if (options.wait) return options.wait();
        return options.ready ? Promise.resolve() : new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error(secret), { name: "TimeoutError" })), timeout);
        });
      }) };
  } });
  const request = (path = validation, method = "POST", requestOrigin = origin) => ({ url: () => requestOrigin + path, method: () => method });
  const respond = (body: unknown, status = 200, path = validation, method = "POST", requestOrigin = origin) => {
    const req = request(path, method, requestOrigin);
    const response = { request: () => req, status: () => status, body: () => Promise.resolve(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) };
    events.emit("request", req); events.emit("response", response);
    return response;
  };
  const run = () => onboardingConnect({ page: page as any, origin, companyId, deadlineAt: Date.now() + (options.durationMs ?? 100), retain: value => { retained = value; } });
  return { page, events, request, respond, run, receipt: () => retained };
}
afterEach(() => { vi.useRealTimers(); });

describe("one onboarding Connect diagnostic boundary", () => {
  it("does not press Connect after the action deadline already expired", async () => {
    const click = vi.fn();
    const f = fixture({ durationMs: 0, click });
    await expect(f.run()).rejects.toMatchObject({ code: "onboarding_connect_timeout" });
    expect(click).not.toHaveBeenCalled();
    expect(f.receipt().checkpoint).toBe("connect");
    expect(f.events.eventNames()).toEqual([]);
  });

  it("rejects a delayed failure body even after Get started becomes visible", async () => {
    let resolveBody!: (bytes: Buffer) => void;
    const body = new Promise<Buffer>(resolve => { resolveBody = resolve; });
    let reviewSeen!: () => void;
    const review = new Promise<void>(resolve => { reviewSeen = resolve; });
    const f = fixture({ wait: async () => { reviewSeen(); }, click: () => {
      const req = f.request(); f.events.emit("request", req);
      f.events.emit("response", { request: () => req, status: () => 200, body: () => body });
    } });
    const result = expect(f.run()).rejects.toMatchObject({ code: "onboarding_native_validation_failed" });
    await review;
    for (let i = 0; i < 10 && f.events.listenerCount("response"); i++) await Promise.resolve();
    expect(f.events.listenerCount("response")).toBe(0);
    resolveBody(Buffer.from(JSON.stringify({ status: "fail", checks: [] })));
    await result;
    expect(f.receipt().validation.outcome).toBe("fail");
    expect(f.receipt().checkpoint).toBe("validation");
    expect(f.events.eventNames()).toEqual([]);
  });

  it.each(["details", "top-level"])("retains a known %s server rejection without its free text", async location => {
    const f = fixture({ click: () => { f.respond({ error: secret, ...(location === "details" ? { details: { code: "agent_runner_config_incompatible", fields: [secret] } } : { code: "agent_runner_unavailable" }) }, 422); } });
    await expect(f.run()).rejects.toMatchObject({ code: "onboarding_native_validation_failed" });
    expect(f.receipt()).toMatchObject({ checkpoint: "validation", validation: { state: "json", httpStatus: 422, serverCode: location === "details" ? "agent_runner_config_incompatible" : "agent_runner_unavailable" }, hire: { state: "missing" } });
    expect(JSON.stringify(f.receipt())).not.toContain(secret);
    validateOnboardingConnectEvidence(f.receipt());
    expect(f.events.listenerCount("response")).toBe(0);
  });

  it.each([{ status: "fail", checks: [] }, { status: "pass", checks: [{ code: "adapter_auth_missing", level: "error" }] }])("fails on a 200 validation rejection: %j", async body => {
    const f = fixture({ click: () => { f.respond(body); } });
    await expect(f.run()).rejects.toMatchObject({ code: "onboarding_native_validation_failed" });
    expect(f.receipt().validation.httpStatus).toBe(200);
  });

  it("retains the hire boundary rejection and does not wait for Get started", async () => {
    const f = fixture({ click: () => { f.respond({ details: { code: "agent_runner_platform_probe_failed" }, error: secret }, 503, hire); } });
    await expect(f.run()).rejects.toMatchObject({ code: "onboarding_agent_hire_failed" });
    expect(f.receipt()).toMatchObject({ checkpoint: "hire", hire: { httpStatus: 503, serverCode: "agent_runner_platform_probe_failed" } });
  });

  it("projects only enums from malicious nested fields, including unknown codes and bounded checks", async () => {
    const f = fixture({ ready: true, click: () => { f.respond({ adapterType: secret, status: secret, code: { credential: secret }, details: { code: secret },
      message: secret, hint: secret, headers: { authorization: secret }, checks: Array.from({ length: 40 }, () => ({ code: secret, level: secret, message: secret, nested: { apiKey: secret } })) }); } });
    const result = await f.run();
    expect(result.validation).toMatchObject({ adapter: "unrecognized", outcome: "unrecognized", serverCode: "unrecognized", truncatedChecks: true });
    expect(result.validation.checks).toHaveLength(32);
    expect(result.validation.checks[0]).toEqual({ code: "unrecognized", level: "unrecognized" });
    expect(JSON.stringify(result)).not.toContain(secret);
    validateOnboardingConnectEvidence(result);
    expect(() => validateOnboardingConnectEvidence({ ...result, validation: { ...result.validation, requestedAdapter: ["codex_local"] } })).toThrow();
  });

  it("ignores wrong origin, company, method, query, and responses without an in-action request", async () => {
    vi.useFakeTimers();
    const f = fixture({ click: () => {
      f.respond({}, 500, validation, "POST", "https://foreign.example.test");
      f.respond({}, 500, validation.replace(companyId, "company-2"));
      f.respond({}, 500, validation, "GET");
      f.respond({}, 500, validation + "?private=" + secret);
      f.events.emit("response", { request: () => f.request(), status: () => 500 });
    } });
    const result = expect(f.run()).rejects.toMatchObject({ code: "onboarding_get_started_timeout" });
    await vi.advanceTimersByTimeAsync(101); await result;
    expect(f.receipt()).toMatchObject({ checkpoint: "connect", validation: { state: "missing" }, hire: { state: "missing" } });
    expect(f.events.eventNames()).toEqual([]);
  });

  it.each([Buffer.from("{not-json"), Buffer.alloc(65_537, "x")])("keeps malformed or oversized bodies unknown and still requires Get started", async bytes => {
    vi.useFakeTimers();
    const f = fixture({ click: () => { f.respond(bytes); } });
    const result = expect(f.run()).rejects.toMatchObject({ code: "onboarding_get_started_timeout" });
    await vi.advanceTimersByTimeAsync(101); await result;
    expect(f.receipt().validation.state).toBe(bytes.byteLength > 65_536 ? "oversized" : "unreadable");
    expect(f.receipt().checkpoint).toBe("validation");
  });

  it("records missing responses and ignores late responses after timeout", async () => {
    vi.useFakeTimers();
    const f = fixture({ click: () => { f.events.emit("request", f.request()); } });
    const result = expect(f.run()).rejects.toMatchObject({ code: "onboarding_get_started_timeout" });
    await vi.advanceTimersByTimeAsync(101); await result;
    const sealed = JSON.stringify(f.receipt());
    f.respond({ status: "pass", adapterType: "paperclip_runner", checks: [] });
    expect(JSON.stringify(f.receipt())).toBe(sealed);
    expect(f.receipt().validation.state).toBe("missing");
  });

  it("bounds stalled JSON reads and cannot mutate retained evidence after return or reject unhandled", async () => {
    vi.useFakeTimers();
    let rejectBody!: (reason: Error) => void;
    const body = new Promise<Buffer>((_resolve, reject) => { rejectBody = reject; });
    const f = fixture({ ready: true, durationMs: 10_000, click: () => {
      const req = f.request(); f.events.emit("request", req);
      f.events.emit("response", { request: () => req, status: () => 200, body: () => body });
    } });
    const result = f.run();
    await vi.advanceTimersByTimeAsync(5001);
    expect((await result).validation.state).toBe("unreadable");
    const sealed = JSON.stringify(f.receipt());
    rejectBody(new Error(secret)); await Promise.resolve();
    expect(JSON.stringify(f.receipt())).toBe(sealed);
    expect(f.events.eventNames()).toEqual([]);
  });

  it("preserves the Get started timeout when a previously received body arrives later", async () => {
    vi.useFakeTimers();
    let resolveBody!: (bytes: Buffer) => void;
    const body = new Promise<Buffer>(resolve => { resolveBody = resolve; });
    const f = fixture();
    const result = expect(f.run()).rejects.toMatchObject({ code: "onboarding_get_started_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    const req = f.request(); f.events.emit("request", req);
    f.events.emit("response", { request: () => req, status: () => 200, body: () => body });
    await vi.advanceTimersByTimeAsync(90);
    resolveBody(Buffer.from(JSON.stringify({ status: "fail" })));
    await vi.advanceTimersByTimeAsync(1); await result;
    expect(f.receipt().checkpoint).toBe("validation");
    expect(f.events.eventNames()).toEqual([]);
  });

  it("keeps a browser error at its own boundary without retaining the browser text", async () => {
    const f = fixture({ click: () => { throw new Error(secret); } });
    await expect(f.run()).rejects.toMatchObject({ code: "onboarding_connect_failed" });
    expect(f.receipt().checkpoint).toBe("connect");
    expect(JSON.stringify(f.receipt())).not.toContain(secret);
    expect(f.events.eventNames()).toEqual([]);
  });

  it("observes both successful responses and requires the visible review step", async () => {
    const f = fixture({ ready: true, click: () => {
      f.respond({ adapterType: "paperclip_runner", status: "pass", checks: [{ code: "codex_hello_probe_passed", level: "info", message: secret }] }, 200, validation.replace("paperclip_runner", "codex_local"));
      f.respond({ agent: { id: secret }, approval: null }, 201, hire);
    } });
    expect(await f.run()).toMatchObject({ checkpoint: "review", validation: { requestedAdapter: "codex_local", adapter: "paperclip_runner", outcome: "pass", checks: [{ code: "codex_hello_probe_passed", level: "info" }] }, hire: { state: "json", httpStatus: 201 } });
    expect(JSON.stringify(f.receipt())).not.toContain(secret);
    expect(f.events.eventNames()).toEqual([]);
  });
});
