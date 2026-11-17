import { afterEach, expect, it, vi } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { RunnerApi, SkillSourceUpdateReadError } from "./api.js";
const company = "11111111-1111-4111-8111-111111111111", skill = "22222222-2222-4222-8222-222222222222";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100"); const traced = { get: vi.fn() };
  const api = new RunnerApi(traced as unknown as APIRequestContext); api.setBrowserSession("synthetic-private-session");
  return { api, traced };
}
it("uses the exact authenticated update endpoint and returns real successful prerequisite bytes unchanged", async () => {
  const { api, traced } = fixture(); const data = { supported: true, currentRef: "old", latestRef: "new", hasUpdate: true };
  const fetcher = vi.fn(async (_url: URL, _options: RequestInit) => Response.json(data)); vi.stubGlobal("fetch", fetcher);
  await expect(api.getSkillSourceUpdateStatus(company, skill)).resolves.toEqual(data);
  expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL(`/api/companies/${company}/skills/${skill}/update-status`, api.baseURL));
  expect(traced.get).not.toHaveBeenCalled();
});
it.each(["skill_source_ref_unavailable", "skill_source_github_rate_limited", "skill_source_github_read_failed"])("retains only the supported closed %s/status while withholding private body fields", async code => {
  const { api } = fixture(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code, error: "Bearer private-error-canary", details: { code, status: 429, token: "secret-value", repository: "private-origin" } }, { status: 422 })));
  const error = await api.getSkillSourceUpdateStatus(company, skill).catch(error => error);
  expect(error).toBeInstanceOf(SkillSourceUpdateReadError); if (!(error instanceof SkillSourceUpdateReadError)) throw error; expect(error).toMatchObject({ status: 422, reason: code, providerStatus: 429 });
  expect(JSON.stringify(error)).not.toMatch(/private-error|secret-value|private-origin|Bearer/); expect(error.message).not.toMatch(/private-error|secret-value|private-origin|Bearer/);
});
it.each(["unknown code", "mismatched code", "oversized", "invalid JSON", "missing code", "invalid provider status"])("does not infer a reason or leak response bytes for %s", async fault => {
  const { api } = fixture(); const code = "skill_source_ref_unavailable";
  let body = JSON.stringify({ code, details: { code, status: 422 }, error: "private-error-canary" });
  if (fault === "unknown code") body = JSON.stringify({ code: "private-error-canary", details: { status: 429 } });
  if (fault === "mismatched code") body = JSON.stringify({ code, details: { code: "private-error-canary", status: 429 } });
  if (fault === "oversized") body = JSON.stringify({ code, details: { status: 422 }, error: "private-error-canary".repeat(2000) });
  if (fault === "invalid JSON") body = "notJSON private-error-canary";
  if (fault === "missing code") body = JSON.stringify({ error: "private-error-canary", details: { status: 429 } });
  if (fault === "invalid provider status") body = JSON.stringify({ code, details: { status: "private-error-canary" } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 422 })));
  const error = await api.getSkillSourceUpdateStatus(company, skill).catch(error => error);
  expect(error).toBeInstanceOf(SkillSourceUpdateReadError); if (!(error instanceof SkillSourceUpdateReadError)) throw error;
  expect(error.reason).toBe(fault === "invalid provider status" ? code : "unclassified"); expect(error.providerStatus).toBeNull();
  expect(JSON.stringify(error)).not.toContain("private-error-canary"); expect(error.message).not.toContain("private-error-canary");
});
it("cancels an oversized error stream at the bound and never reads its trailing private data", async () => {
  const { api } = fixture(); let cancelled = false; const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel() { cancelled = true; } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 422 })));
  await expect(api.getSkillSourceUpdateStatus(company, skill)).rejects.toMatchObject({ reason: "unclassified" }); expect(cancelled).toBe(true);
});
it("refuses missing human auth or malformed identities before any request", async () => {
  const { api } = fixture(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(api.getSkillSourceUpdateStatus("https://foreign.invalid", skill)).rejects.toThrow("exact owned");
  await expect(api.getSkillSourceUpdateStatus(company, "../other")).rejects.toThrow("exact owned");
  const noSession = new RunnerApi({} as APIRequestContext); await expect(noSession.getSkillSourceUpdateStatus(company, skill)).rejects.toThrow("human-session");
  expect(fetcher).not.toHaveBeenCalled();
});
