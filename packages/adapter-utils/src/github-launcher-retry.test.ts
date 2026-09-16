import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { githubLauncherSource } from "./github-launcher.js";

// Execute the exact self-contained acquisition code staged inside the launcher.
// A virtual clock exercises the real 35s/75s budgets without sleeping for them.
function acquisitionFixture() {
  let now = 0;
  const budgets: number[] = [];
  const signals: Array<{ budget: number; aborted: boolean; reason?: Error }> = [];
  const sleeps: number[] = [];
  const fetch = vi.fn();
  const source = githubLauncherSource();
  const context = vm.createContext({
    fetch, Set, SyntaxError,
    Date: { now: () => now },
    AbortSignal: { timeout: (ms: number) => { budgets.push(ms); const signal = { budget: ms, aborted: false }; signals.push(signal); return signal; } },
    setTimeout: (callback: () => void, ms: number) => { sleeps.push(ms); now += ms; callback(); },
  });
  vm.runInContext(source.slice(source.indexOf("const credentialRequestTimeoutMs"), source.indexOf("async function main()")), context);
  return {
    fetch, budgets, sleeps, signals, advance: (ms: number) => { now += ms; },
    acquire: () => vm.runInContext("acquireCredentials('http://bridge/runtime-tools/github/credentials', { authorization: 'Bearer bridge-token', 'x-paperclip-github-capability': 'run-capability' })", context) as Promise<unknown>,
  };
}
function response(status = 200, result: unknown = { status: "available", env: { GH_TOKEN: "fixture-token" } }) {
  return { ok: status === 200, status, body: { cancel: vi.fn().mockResolvedValue(undefined) }, json: vi.fn().mockResolvedValue(result) };
}

describe("staged Git credential acquisition budgets", () => {
  it("lets a file-bridge response arrive after the old 10s deadline", async () => {
    const fixture = acquisitionFixture();
    fixture.fetch.mockImplementationOnce(async () => {
      fixture.advance(11_000);
      return response();
    });
    await expect(fixture.acquire()).resolves.toMatchObject({ status: "available" });
    expect(fixture.budgets).toEqual([35_000]);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("reacquires after a reset and 503 without changing the capability", async () => {
    const fixture = acquisitionFixture();
    const unavailable = response(503);
    fixture.fetch.mockRejectedValueOnce(Object.assign(new TypeError("secret upstream URL"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(unavailable).mockResolvedValueOnce(response());
    await expect(fixture.acquire()).resolves.toMatchObject({ env: { GH_TOKEN: "fixture-token" } });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(unavailable.body.cancel).toHaveBeenCalledOnce();
    expect(fixture.sleeps).toEqual([250, 500]);
    for (const [, input] of fixture.fetch.mock.calls) {
      expect(input.headers).toEqual({ authorization: "Bearer bridge-token", "x-paperclip-github-capability": "run-capability" });
      expect(input.body).toBe("{}");
    }
  });

  it("exhausts three transient failures with a finite sanitized error", async () => {
    const fixture = acquisitionFixture();
    fixture.fetch.mockRejectedValue(Object.assign(new Error("secret body"), { name: "TimeoutError" }));
    await expect(fixture.acquire()).rejects.toMatchObject({ credentialCategory: "timeout", message: "GitHub credential acquisition failed" });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 400, 500])("does not retry permanent HTTP %s", async (status) => {
    const fixture = acquisitionFixture();
    fixture.fetch.mockResolvedValue(response(status));
    await expect(fixture.acquire()).rejects.toMatchObject({ credentialCategory: status === 401 || status === 403 ? "denied" : "unavailable" });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry malformed JSON or an unknown fetch error", async () => {
    for (const error of [new SyntaxError("secret response"), new TypeError("unclassified fetch failure")]) {
      const fixture = acquisitionFixture();
      fixture.fetch.mockResolvedValue({ ...response(), json: async () => { throw error; } });
      await expect(fixture.acquire()).rejects.toMatchObject({ credentialCategory: error instanceof SyntaxError ? "invalidresponse" : "unavailable" });
      expect(fixture.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the timeout active through body consumption and retries a body timeout", async () => {
    const fixture = acquisitionFixture();
    fixture.fetch.mockResolvedValueOnce({ ...response(), json: async () => {
      fixture.advance(35_000);
      fixture.signals[0].aborted = true;
      fixture.signals[0].reason = Object.assign(new Error("deadline"), { name: "TimeoutError" });
      throw Object.assign(new Error("body stalled"), { name: "AbortError" });
    } }).mockResolvedValueOnce(response());
    await expect(fixture.acquire()).resolves.toMatchObject({ status: "available" });
    expect(fixture.budgets).toEqual([35_000, 35_000]);
  });

  it("caps mixed retries and steering waits at 75s and rejects late credentials", async () => {
    const fixture = acquisitionFixture();
    fixture.fetch.mockImplementationOnce(async () => { fixture.advance(35_000); throw Object.assign(new Error(), { name: "TimeoutError" }); })
      .mockImplementationOnce(async () => { fixture.advance(35_000); return response(409); })
      .mockImplementationOnce(async () => { fixture.advance(4_000); return response(); });
    await expect(fixture.acquire()).rejects.toMatchObject({ credentialCategory: "timeout" });
    expect(fixture.budgets).toEqual([35_000, 35_000, 3_750]);
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds steering reconciliation to thirty requests", async () => {
    const fixture = acquisitionFixture();
    fixture.fetch.mockResolvedValue(response(409));
    await expect(fixture.acquire()).rejects.toMatchObject({ credentialCategory: "unavailable" });
    expect(fixture.fetch).toHaveBeenCalledTimes(30);
    expect(fixture.sleeps).toHaveLength(29);
  });
});
