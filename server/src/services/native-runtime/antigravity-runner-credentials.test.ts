import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { antigravityCredentialTurn, bindAntigravityCredentialTurn, prepareAntigravityRunnerCredentials } from "./antigravity-runner-credentials.js";
import { completeManagedNativeCredentialTurn } from "./managed-native-credentials.js";
import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
import { bindRetainedGoogleCredentialHome } from "../retained-google-credential-cleanup.js";

const roots: string[] = [];
const credential = (token: string) => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
});
async function home() { const root = await realpath(await mkdtemp(join(tmpdir(), "antigravity-controller-test-"))); roots.push(root); await mkdir(join(root, "antigravity-acp"), { mode: 0o700 }); return root; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Antigravity managed Runner credentials", () => {
  it("requires a selected managed account and never borrows the ambient Google home or inline secret", async () => {
    const ambient = await home();
    await writeFile(join(ambient, "antigravity-acp", "acp_token.json"), credential("fixture-ambient"), { mode: 0o600 });
    vi.stubEnv("GEMINI_HOME", ambient);
    vi.stubEnv("GEMINI_API_KEY", "fixture-ambient-key");
    await expect(prepareAntigravityRunnerCredentials({ remote: false, environment: { GEMINI_HOME: ambient, PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: credential("fixture-spoofed") } })).rejects.toThrow("selected managed Google account");
  });
  it("uses the explicit API key while removing all subscription home and payload inputs", async () => {
    expect(await prepareAntigravityRunnerCredentials({ remote: true, environment: {
      GEMINI_API_KEY: "fixture-selected", GOOGLE_API_KEY: "other", GEMINI_HOME: "/ambient", GOOGLE_APPLICATION_CREDENTIALS: "/ambient.json",
      GOOGLE_CLOUD_ACCESS_TOKEN: "ambient", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "spoofed",
    } })).toEqual({ home: null, environment: { GEMINI_API_KEY: "fixture-selected" } });
  });
  it("projects only the selected private token and rejects remote subscription delivery", async () => {
    const managedHome = await home();
    await writeFile(join(managedHome, "antigravity-acp", "acp_token.json"), credential("fixture-selected"), { mode: 0o600 });
    expect(await prepareAntigravityRunnerCredentials({ remote: false, managedHome, environment: { GEMINI_HOME: "/untrusted" } })).toEqual({
      home: managedHome, credential: credential("fixture-selected"), environment: { PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: credential("fixture-selected") },
    });
    await expect(prepareAntigravityRunnerCredentials({ remote: true, managedHome, environment: {} })).rejects.toThrow("not qualified for remote");
    await expect(prepareAntigravityRunnerCredentials({ remote: false, managedHome, environment: {}, lifecycleMode: "warm" })).rejects.toThrow("warm sessions are not qualified");
  });
  it.each(["symlink", "public", "invalid"])("rejects a %s selected token without using a fallback", async kind => {
    const managedHome = await home(), token = join(managedHome, "antigravity-acp", "acp_token.json");
    const other = join(managedHome, "other.json");
    await writeFile(other, credential("fixture-other"), { mode: 0o600 });
    if (kind === "symlink") await symlink(other, token);
    else await writeFile(token, kind === "invalid" ? "{}" : credential("fixture-selected"), { mode: kind === "public" ? 0o644 : 0o600 });
    await expect(prepareAntigravityRunnerCredentials({ remote: false, managedHome, environment: {} })).rejects.toThrow("selected Google Antigravity account is unavailable");
  });
  it.each(["acp_token.json", "auth-refresh.json"])("preserves %s refreshes, then scrubs runtime credentials only after provider close", async source => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), runtime = join(runtimeHome, "antigravity-acp");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    for (const name of [source, "auth-refresh.json.tmp"]) await writeFile(join(runtime, name), credential("fixture-refreshed"), { mode: 0o600 });
    const close = vi.fn(async () => { expect(await readFile(join(runtime, source), "utf8")).toBe(credential("fixture-refreshed")); });
    const session = bindAntigravityCredentialTurn({ close } as unknown as NativeSession,
      { managedHome, runtimeHome, credential: credential("fixture-original") });
    await completeManagedNativeCredentialTurn(session);
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-refreshed"));
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(close).toHaveBeenCalledOnce();
    await expect(access(join(runtime, source))).rejects.toMatchObject({ code: "ENOENT" });
    await session.close({ reason: "completed" });
    expect(close).toHaveBeenCalledOnce();
    for (const name of ["acp_token.json", "auth-refresh.json", "auth-refresh.json.tmp"]) await expect(access(join(runtime, name))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps a newer invocation destination and fails closed on an invalid runtime token", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), source = join(runtimeHome, "antigravity-acp", "acp_token.json");
    await writeFile(destination, credential("fixture-concurrent"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    const turn = antigravityCredentialTurn({ managedHome, runtimeHome, credential: credential("fixture-original") });
    await expect(turn.copyBack()).rejects.toThrow("destination changed");
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-concurrent"));
    await chmod(source, 0o644);
    await expect(turn.copyBack()).rejects.toThrow("handoff is invalid");
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-concurrent"));
  });
  it("can confirm a completed identical copy after losing its prior completion", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-refreshed"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    await antigravityCredentialTurn({ managedHome, runtimeHome, credential: credential("fixture-original") }).copyBack();
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-refreshed"));
  });
  it("retains a rotated refresh after failed copy-back and retries the retired owner before scrubbing", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o644 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    const close = vi.fn(async () => {});
    const session = bindAntigravityCredentialTurn({ close } as unknown as NativeSession,
      { managedHome, runtimeHome, credential: credential("fixture-original") });
    await expect(completeManagedNativeCredentialTurn(session)).rejects.toThrow("destination is invalid");
    expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
    await chmod(destination, 0o600);
    await session.close({ reason: "retry credential handoff" });
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-refreshed"));
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("settles the retained runtime refresh before preparing another launch for the same account", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const release = bindRetainedGoogleCredentialHome(managedHome, { companyId: "company", accountKey: managedHome });
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o644 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    const close = vi.fn(async () => {});
    const session = bindAntigravityCredentialTurn({ close } as unknown as NativeSession,
      { managedHome, runtimeHome, credential: credential("fixture-original") });
    try {
      await expect(completeManagedNativeCredentialTurn(session)).rejects.toThrow("destination is invalid");
      await expect(prepareAntigravityRunnerCredentials({ managedHome, remote: false, environment: {} }))
        .rejects.toThrow("still completing credential cleanup");
      expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
      await chmod(destination, 0o600);
      expect((await prepareAntigravityRunnerCredentials({ managedHome, remote: false, environment: {} })).credential)
        .toBe(credential("fixture-refreshed"));
      expect(close).toHaveBeenCalledOnce();
      await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { release(); }
  });
  it("does not copy or scrub a successor's credentials after the controller detached", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), source = join(runtimeHome, "antigravity-acp", "acp_token.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    const close = vi.fn(async () => {}), detach = vi.fn(async () => {});
    const session = bindAntigravityCredentialTurn({ close, detachControllerForRestart: detach } as unknown as NativeSession,
      { managedHome, runtimeHome, credential: credential("fixture-original") });
    await session.detachControllerForRestart!();
    await session.close({ reason: "old controller" });
    expect(close).not.toHaveBeenCalled();
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
    expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
  });
});
