import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ANTIGRAVITY_AUTH_ENV, stageManagedAntigravityCredential } from "./antigravity-credentials.js";
import { ACPX_CREDENTIAL_BINDING_ENV, createAcpxCredentialBinding, createAcpxSidecarHostEnvironment, createSanitizedAcpxSpawnInput } from "./environment.js";
import { configuredEnvironmentProjection } from "../../configured-environment.js";
import * as codexCredentials from "./codex-credentials.js";

const roots: string[] = [];
const credential = JSON.stringify({ client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  client_secret: "fixture-client", refresh_token: "fixture-refresh", token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"] });
async function home() { const value = await realpath(await mkdtemp(join(tmpdir(), "antigravity-credential-test-"))); roots.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([{}, { [ANTIGRAVITY_AUTH_ENV]: "{}" }, { [ANTIGRAVITY_AUTH_ENV]: credential, GEMINI_API_KEY: "fixture-key" }])("rejects absent, malformed or ambiguous credentials", async environment => {
  await expect(stageManagedAntigravityCredential({ agentHomeDirectory: await home(), environment })).rejects.toThrow(/credential/);
});

it("keeps OAuth bound to its sidecar session and out of the actual native environment", () => {
  const source = { [ANTIGRAVITY_AUTH_ENV]: credential };
  const env = { ...source, [ACPX_CREDENTIAL_BINDING_ENV]: createAcpxCredentialBinding(source, "antigravity", "one") };
  expect(createAcpxSidecarHostEnvironment(env, "antigravity", "one")[ANTIGRAVITY_AUTH_ENV]).toBe(credential);
  expect(() => createAcpxSidecarHostEnvironment(env, "antigravity", "other")).toThrow(/binding/);
  expect(() => createAcpxSidecarHostEnvironment(source, "antigravity", "one")).toThrow(/binding/);
  expect(createSanitizedAcpxSpawnInput(source, "antigravity").env[ANTIGRAVITY_AUTH_ENV]).toBeUndefined();
  vi.stubEnv(ANTIGRAVITY_AUTH_ENV, credential);
  expect(createSanitizedAcpxSpawnInput(undefined, "antigravity").env[ANTIGRAVITY_AUTH_ENV]).toBeUndefined();
});

it("fences refresh owners, preserves native rotation, scrubs live files and removes stale handoffs on reuse", async () => {
  const root = await home(), directory = join(root, "antigravity-acp");
  const input = { agentHomeDirectory: root, environment: { [ANTIGRAVITY_AUTH_ENV]: credential } };
  const first = await stageManagedAntigravityCredential(input);
  try {
    expect((await stat(join(directory, "acp_token.json"))).mode & 0o777).toBe(0o600);
    await expect(stageManagedAntigravityCredential(input)).rejects.toThrow(/active lease|owned/);
    const rotated = credential.replace("fixture-refresh", "rotated-refresh");
    await writeFile(join(directory, "acp_token.json"), rotated, { mode: 0o600 });
    await Promise.all([first.close(), first.close()]);
    expect(await readFile(join(directory, "auth-refresh.json"), "utf8")).toBe(rotated);
    for (const name of ["auth.json", "acp_token.json"]) await expect(stat(join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
    const second = await stageManagedAntigravityCredential(input);
    try { await expect(stat(join(directory, "auth-refresh.json"))).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { await second.close(); }
  } finally { await first.close(); }
});

it("retains ownership when a token is replaced by a symlink, and never reads its target", async () => {
  const root = await home(), token = join(root, "antigravity-acp", "acp_token.json");
  const input = { agentHomeDirectory: root, environment: { [ANTIGRAVITY_AUTH_ENV]: credential } };
  const lease = await stageManagedAntigravityCredential(input), target = join(await home(), "unrelated");
  await writeFile(target, "unrelated", { mode: 0o600 });
  await rm(token); await symlink(target, token);
  await expect(lease.close()).rejects.toThrow();
  await expect(stageManagedAntigravityCredential(input)).rejects.toThrow(/active lease|owned/);
  expect(await readFile(target, "utf8")).toBe("unrelated");
  await rm(token); await writeFile(token, credential, { mode: 0o600 }); await lease.close();
});

it("preserves a native OAuth rotation when startup admission never succeeds", async () => {
  const root = await home(), directory = join(root, "antigravity-acp");
  const lease = await stageManagedAntigravityCredential({ agentHomeDirectory: root,
    environment: { [ANTIGRAVITY_AUTH_ENV]: credential }, retainRefresh: () => false });
  const rotated = credential.replace("fixture-refresh", "failed-startup-rotation");
  await writeFile(join(directory, "acp_token.json"), rotated, { mode: 0o600 });
  await lease.close();
  expect(await readFile(join(directory, "auth-refresh.json"), "utf8")).toBe(rotated);
  expect((await stat(join(directory, "auth-refresh.json"))).mode & 0o777).toBe(0o600);
  await expect(stat(join(directory, "acp_token.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries the original lifetime lease after its first close fails without losing the rotated handoff", async () => {
  const stage = codexCredentials.stageManagedCodexCredential;
  let attempts = 0;
  vi.spyOn(codexCredentials, "stageManagedCodexCredential").mockImplementation(async input => {
    const actual = await stage(input);
    return { ...actual, close: async () => {
      if (++attempts === 1) throw new Error("injected lifetime close failure");
      await actual.close();
    } };
  });
  const root = await home(), directory = join(root, "antigravity-acp");
  const input = { agentHomeDirectory: root, environment: { [ANTIGRAVITY_AUTH_ENV]: credential } };
  const lease = await stageManagedAntigravityCredential(input);
  const rotated = credential.replace("fixture-refresh", "retry-close-rotation");
  await writeFile(join(directory, "acp_token.json"), rotated, { mode: 0o600 });
  try {
    await expect(lease.close()).rejects.toThrow("injected lifetime close failure");
    await expect(lease.close()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(await readFile(join(directory, "auth-refresh.json"), "utf8")).toBe(rotated);
    const next = await stageManagedAntigravityCredential(input); await next.close();
  } finally { await lease.close(); }
});

it("leaves no unchanged OAuth handoff after failed admission or an API-key session", async () => {
  for (const environment of [{ [ANTIGRAVITY_AUTH_ENV]: credential }, { GEMINI_API_KEY: "fixture-key" }]) {
    const root = await home();
    const lease = await stageManagedAntigravityCredential({ agentHomeDirectory: root, environment, retainRefresh: () => false });
    await lease.close();
    for (const name of ["auth.json", "acp_token.json", "auth-refresh.json"]) await expect(stat(join(root, "antigravity-acp", name))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("keeps the selected key while removing conflicting explicitly projected Google auth and runtime controls", () => {
  const source = configuredEnvironmentProjection({
    GEMINI_API_KEY: "selected-key", GOOGLE_API_KEY: "other-key", GOOGLE_APPLICATION_CREDENTIALS: "/foreign/adc.json",
    GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "foreign-project", GEMINI_HOME: "/foreign/home",
    AGY_LLM_GATEWAY_URL: "https://foreign.invalid", ANTIGRAVITY_HARNESS_PATH: "/foreign/helper",
    CLOUDSDK_CONFIG: "/foreign/cloud", AGY_ACP_FORCE_FILE_STORAGE: "0", TASK_INPUT: "retained",
  });
  const env = createSanitizedAcpxSpawnInput(source, "antigravity").env;
  expect(env.GEMINI_API_KEY).toBe("selected-key");
  expect(env.TASK_INPUT).toBe("retained");
  for (const name of Object.keys(source)) {
    if (/^(?:GOOGLE_|GEMINI_|AGY_|ANTIGRAVITY_|CLOUDSDK_)/.test(name) && name !== "GEMINI_API_KEY") expect(env[name]).toBeUndefined();
  }
  expect(JSON.parse(env.PAPERCLIP_CONFIGURED_ENV_KEYS!)).toEqual(["GEMINI_API_KEY", "TASK_INPUT"]);
});

it("does not borrow an ambient Gemini key", () => {
  vi.stubEnv("GEMINI_API_KEY", "ambient-key");
  expect(createSanitizedAcpxSpawnInput(undefined, "antigravity").env.GEMINI_API_KEY).toBeUndefined();
});
