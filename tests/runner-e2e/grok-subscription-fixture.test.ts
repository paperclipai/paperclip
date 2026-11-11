import { mkdtemp, mkdir, readFile, realpath, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveManagedGrokHomeDir } from "../../packages/adapters/grok-local/src/server/grok-home.js";
import { stageGrokSubscriptionFixture } from "./grok-subscription-fixture.js";
import { findSecretLeak, normalizedSecrets, sanitizeJson } from "./redaction.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";

const companyId = "11111111-2222-4333-8444-555555555555";
const raw = JSON.stringify({ [`https://auth.x.ai::${companyId}`]: {
  key: "fixture-access-credential", refresh_token: "fixture-refresh-credential", email: "fixture@example.invalid",
} });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "grok-fixture-")));
  roots.push(root);
  const home = path.join(root, "paperclip-home");
  await mkdir(home);
  return { PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root, PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "runner-e2e-test" };
}

it("stages only the explicit company credential privately and cleans refreshed state", async () => {
  const environment = await setup();
  const remove = await stageGrokSubscriptionFixture({ raw, companyId, environment });
  const home = resolveManagedGrokHomeDir(environment, companyId);
  expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(raw);
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(home, "auth.json"))).mode & 0o777).toBe(0o600);
  await expect(stageGrokSubscriptionFixture({ raw, companyId, environment })).rejects.toThrow();
  await remove();
  await expect(stat(home)).rejects.toThrow();
});

it("refuses malformed credentials and nonisolated or redirected homes", async () => {
  const environment = await setup();
  await expect(stageGrokSubscriptionFixture({ raw: "{}", companyId, environment })).rejects.toThrow("malformed");
  await expect(stageGrokSubscriptionFixture({ raw, companyId: "../outside", environment })).rejects.toThrow("isolated");
  await expect(stageGrokSubscriptionFixture({ raw, companyId, environment: { ...environment, PAPERCLIP_HOME: tmpdir() } })).rejects.toThrow("outside");
  const home = resolveManagedGrokHomeDir(environment, companyId);
  await mkdir(path.dirname(home), { recursive: true });
  await symlink(tmpdir(), home);
  await expect(stageGrokSubscriptionFixture({ raw, companyId, environment })).rejects.toThrow("redirected");
});

it("strips subscription input from the server environment and masks token fragments", () => {
  const env = buildPaperclipServerEnvironment({ GROK_AUTH_JSON: raw, XAI_API_KEY: "other-key" });
  expect(env.GROK_AUTH_JSON).toBeUndefined();
  expect(env.XAI_API_KEY).toBeUndefined();
  const secrets = normalizedSecrets([raw]);
  expect(findSecretLeak("fixture-refresh-credential", secrets)).toBeTruthy();
  expect(sanitizeJson({ message: "fixture-access-credential fixture@example.invalid" }, secrets)).toEqual({ message: "[REDACTED] [REDACTED]" });
});
