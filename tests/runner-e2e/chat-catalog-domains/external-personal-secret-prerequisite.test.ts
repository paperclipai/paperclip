import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { personalSecretExternalCases, personalSecretUnboundConfigHash, preparePersonalSecretWorker, provePersonalSecretMissingBoundary } from "./external-personal-secret.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100);
  const config = { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", env: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "controller", version: "latest" } } };
  const ready = { id: "morgan", companyId: "company", lifecycleState: "ready", lifecycleHolds: [] as string[], lifecycleError: null as string | null, status: "idle", adapterType: "paperclip_runner", adapterConfig: config };
  const agent = { ...ready, adapterConfig: { ...config, env: { ...config.env, PUBLISHING_API_KEY: { type: "user_secret_ref", key: "PERSONAL_PUBLISHING_KEY", version: "latest", required: true, allowMissingOverride: false } } } };
  const lead = { ...ready, id: "ceo" }, evidence = vi.fn();
  const get = vi.fn(async (route: string) => route === "/api/agents/ceo" ? lead : ready);
  const ctx = { observationDeadlineAt: 10000, input: { api: { baseURL: "http://127.0.0.1:3100", get }, evidence, fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, page: { context: () => ({ cookies: async () => [{ name: "session", value: "synthetic-private-session" }] }) } } } as unknown as ChatCatalogContext;
  const state = { morganId: "morgan", morganReadyBeforeRequiredBinding: true, morganUnboundConfigHash: personalSecretUnboundConfigHash(config), definitionId: "definition", currentPersonId: "person" };
  const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ code: "user_secret_missing", details: { code: "user_secret_missing", definitionId: "definition", responsibleUserId: "person" } }), { status: 422 }));
  vi.stubGlobal("fetch", fetcher);
  return { ctx, ready, agent, lead, state, get, fetcher, evidence };
}
it("preserves the exact missing-value scenario instead of demanding every configured worker ready", () => {
  expect(personalSecretExternalCases[0]!.setupPolicy).toEqual({ readiness: "preserve-scenario", invariantCheckIds: ["current-owner-missing-required-personal-value"] });
  expect(personalSecretExternalCases[0]!.verifySetup).toBeTypeOf("function");
});
it("proves the worker ready before adding the missing required value and does no provider probe", async () => {
  const f = fixture(); await expect(preparePersonalSecretWorker(f.ctx, "morgan")).resolves.toEqual(f.ready);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.ready.lifecycleError = "Authentication failed";
  await expect(preparePersonalSecretWorker(f.ctx, "morgan")).rejects.toThrow("unrelated setup failure");
});
it("requires exact current-person missing-secret resolution and ready CEO with unchanged worker configuration", async () => {
  const f = fixture(); await provePersonalSecretMissingBoundary(f.ctx, f.state, f.agent);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls[0]?.[0]).toEqual(new URL("http://127.0.0.1:3100/api/companies/company/adapters/paperclip_runner/test-environment"));
  expect(f.evidence).toHaveBeenCalledWith("personal-secret-missing-binding-prerequisite.json", expect.objectContaining({ status: 422, code: "user_secret_missing", prospectiveResolutionOnly: true }));
  expect(JSON.stringify(f.evidence.mock.calls)).not.toContain("synthetic-private-session");
});
it.each(["bad CEO", "bad worker", "budget hold", "wrong company", "changed model", "optional", "override", "wrong definition", "never ready"])("rejects unrelated %s before any resolution request", async invalid => {
  const f = fixture();
  if (invalid === "bad CEO") f.lead.lifecycleError = "Authentication failed";
  if (invalid === "bad worker") f.agent.lifecycleError = "Authentication failed";
  if (invalid === "budget hold") f.agent.lifecycleHolds = ["budget"];
  if (invalid === "wrong company") f.agent.companyId = "foreign";
  if (invalid === "changed model") f.agent.adapterConfig.model = "other";
  if (invalid === "optional") f.agent.adapterConfig.env.PUBLISHING_API_KEY.required = false;
  if (invalid === "override") f.agent.adapterConfig.env.PUBLISHING_API_KEY.allowMissingOverride = true;
  if (invalid === "wrong definition") f.agent.adapterConfig.env.PUBLISHING_API_KEY.key = "OTHER";
  if (invalid === "never ready") f.state.morganReadyBeforeRequiredBinding = false;
  await expect(provePersonalSecretMissingBoundary(f.ctx, f.state, f.agent)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.evidence).not.toHaveBeenCalled();
});
it.each(["other status", "other code", "other definition", "other person", "missing details"])("refuses %s rather than treating any failure as the intended prerequisite", async invalid => {
  const f = fixture(), body = { code: "user_secret_missing", details: { code: "user_secret_missing", definitionId: "definition", responsibleUserId: "person" } };
  if (invalid === "other code") body.code = "harness_auth_failed";
  if (invalid === "other definition") body.details.definitionId = "other";
  if (invalid === "other person") body.details.responsibleUserId = "other";
  if (invalid === "missing details") delete (body as { details?: unknown }).details;
  f.fetcher.mockImplementation(async () => new Response(JSON.stringify(body), { status: invalid === "other status" ? 500 : 422 }));
  await expect(provePersonalSecretMissingBoundary(f.ctx, f.state, f.agent)).rejects.toThrow("exact current-person missing binding");
  expect(f.evidence).not.toHaveBeenCalled();
});
it("does not let a slow resolution reset the original observation clock", async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => { vi.setSystemTime(10001); return new Response(JSON.stringify({ code: "user_secret_missing", details: { code: "user_secret_missing", definitionId: "definition", responsibleUserId: "person" } }), { status: 422 }); });
  await expect(provePersonalSecretMissingBoundary(f.ctx, f.state, f.agent)).rejects.toThrow("budget");
  expect(f.evidence).not.toHaveBeenCalled();
});

it("accepts only the source-owned missing-binding lifecycle state once the precise resolution guard proves it", async () => {
  const f = fixture(); f.agent.lifecycleState = "verifying"; f.agent.status = "paused";
  f.agent.lifecycleError = "Execution configuration check failed. Paperclip could not complete this step. It will retry automatically. If this continues, contact your instance administrator.";
  await expect(provePersonalSecretMissingBoundary(f.ctx, f.state, f.agent)).resolves.toBeUndefined();
});
it("does not expose malformed private response contents", async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => new Response("synthetic-private-invalid-json", { status: 422 }));
  await expect(provePersonalSecretMissingBoundary(f.ctx, f.state, f.agent)).rejects.toThrow("contents withheld");
  expect(f.evidence).not.toHaveBeenCalled();
});
