import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { checkSetupHealthCredential } from "./chat-setup-credential.js";
import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
const key = "synthetic-credential-never-retained";
const input = () => ({ executionId: "chat-setup-health.runner-opencode.local.setup-only", provider: "opencode", model: CHAT_OPENCODE_MODEL,
  credential: key, platform: "linux", secrets: [] as string[], now: Date.parse("2026-10-27T00:00:00Z"), env: {
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master",
    GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master" } });
const valid = { data: { is_free_tier: false, usage: 123.45, limit: 150, limit_remaining: 26.55, expires_at: null,
  label: key, creator_user_id: "private-person-id", workspace_id: "private-workspace-id" } };
it("registers before exactly one fixed read-only request and retains closed recognition facts", async () => {
  const i = input();
  const fetch = vi.fn(async (url, options) => {
    expect(i.secrets).toContain(key); expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: `Bearer ${key}` } });
    expect(options.signal).toBeInstanceOf(AbortSignal); return Response.json(valid);
  });
  const receipt = await checkSetupHealthCredential({ ...i, fetch });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(receipt).toEqual({ schema: "paperclip.setup-health-credential/v1", code: "recognized", httpStatus: 200, recognized: true, expired: false, budgetAvailable: true });
  expect(JSON.stringify(receipt)).not.toMatch(/synthetic|private-|123\.45|26\.55|150|label|workspace/);
});
it.each([401, 403, 429, 500])("does not parse or retain HTTP%s body and never retries", async status => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: key, account: "private-person-id" } }), { status }));
  const receipt = await checkSetupHealthCredential({ ...input(), fetch });
  expect(receipt.recognized).toBe(false); expect(receipt.httpStatus).toBe(status); expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(receipt)).not.toMatch(/synthetic|private-|message|account/);
});
it.each([{}, { data: { label: key } }, { ...valid, data: { ...valid.data, usage: "123" } }])("refuses malformed HTTP200 recognition evidence", async body => {
  const receipt = await checkSetupHealthCredential({ ...input(), fetch: vi.fn(async () => Response.json(body)) });
  expect(receipt).toMatchObject({ code: "invalid-response", recognized: false, httpStatus: 200 });
});
it("reports actual expiry and zero/unlimited budget distinctly without amounts", async () => {
  const expired = await checkSetupHealthCredential({ ...input(), fetch: vi.fn(async () => Response.json({ data: { ...valid.data, expires_at: "2026-10-01T00:00:00Z", limit_remaining: 0 } })) });
  expect(expired).toMatchObject({ recognized: true, expired: true, budgetAvailable: false });
  const unlimited = await checkSetupHealthCredential({ ...input(), fetch: vi.fn(async () => Response.json({ data: { ...valid.data, limit: null, limit_remaining: null } })) });
  expect(unlimited).toMatchObject({ recognized: true, budgetAvailable: null });
});
it("withholds thrown network/timeout details and bounds response bodies", async () => {
  const fetch = vi.fn(async () => { throw new Error(`Authorization ${key} private-error`); });
  expect(await checkSetupHealthCredential({ ...input(), fetch })).toMatchObject({ code: "request-failed", recognized: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  const oversized = await checkSetupHealthCredential({ ...input(), fetch: vi.fn(async () => new Response("x".repeat(32769))) });
  expect(oversized).toMatchObject({ code: "invalid-response", recognized: false });
});
it("never requests outside exact trusted remote health/profile prerequisites", async () => {
  const fetch = vi.fn();
  for (const override of [{ executionId: "chat-features.runner-opencode.local.create-backlog" }, { platform: "darwin" },
    { provider: "codex" }, { model: "another/model" }, { credential: "" }, { env: {} }]) {
    expect(await checkSetupHealthCredential({ ...input(), ...override, fetch })).toMatchObject({ code: "prerequisite-missing", recognized: false });
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("gates ordinary fixture creation on recognition and fingerprints the diagnostic source", () => {
  const source = readFileSync(new URL("./runner.spec.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (execution.task.flow === "setup_health") {');
  const guard = source.indexOf('if (!credential.recognized) throw', start);
  const fixtures = source.indexOf('fixtures = await withSdkCanaryPreFixture(', start);
  expect(start).toBeGreaterThan(0); expect(guard).toBeGreaterThan(start); expect(fixtures).toBeGreaterThan(guard);
  expect(readFileSync(new URL("./chat-setup-health.ts", import.meta.url), "utf8")).toContain('"chat-setup-credential.ts"');
});
