import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { codexSubscriptionAgentConfig, stageCodexSubscriptionFixture } from "./codex-subscription-fixture.js";
import { resolveManagedCodexHomeDir } from "../../packages/adapters/codex-local/src/server/codex-home.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
import { normalizedSecrets, findSecretLeak } from "./redaction.js";
const companyId = "11111111-2222-4333-8444-555555555555";
const raw = JSON.stringify({ tokens: { account_id: "fixture-account", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", id_token: "fixture-id-token" } });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function environment() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-fixture-"))); roots.push(root);
  const home = path.join(root, "paperclip-home"); await mkdir(home);
  return { PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root, PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "runner-e2e-test" };
}
it("seeds only explicit subscription auth into a new disposable production company home", async () => {
  const env = await environment(), home = resolveManagedCodexHomeDir(env, companyId);
  const config = codexSubscriptionAgentConfig({ adapterConfig: { provider: "codex", env: {} } }, env, companyId);
  expect(config.adapterConfig.env).toEqual({ CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "" });
  const remove = await stageCodexSubscriptionFixture({ raw, companyId, environment: env });
  expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(raw);
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(home, "auth.json"))).mode & 0o777).toBe(0o600);
  await expect(stageCodexSubscriptionFixture({ raw, companyId, environment: env })).rejects.toThrow();
  await remove(); await expect(stat(home)).rejects.toThrow();
});
it("rejects API keys, malformed data and redirected nonisolated homes", async () => {
  const env = await environment();
  await expect(stageCodexSubscriptionFixture({ raw: '{"OPENAI_API_KEY":"fixture"}', companyId, environment: env })).rejects.toThrow("subscription");
  await expect(stageCodexSubscriptionFixture({ raw, companyId: "../outside", environment: env })).rejects.toThrow("isolated");
  const home = resolveManagedCodexHomeDir(env, companyId);
  await mkdir(path.dirname(home), { recursive: true }); await symlink(tmpdir(), home);
  await expect(stageCodexSubscriptionFixture({ raw, companyId, environment: env })).rejects.toThrow("redirected");
});
it("strips login JSON from server process environment and redacts individual tokens", () => {
  expect(buildPaperclipServerEnvironment({ CODEX_AUTH_JSON: raw }).CODEX_AUTH_JSON).toBeUndefined();
  expect(findSecretLeak("fixture-refresh-token", normalizedSecrets([raw]))).toBeTruthy();
});
