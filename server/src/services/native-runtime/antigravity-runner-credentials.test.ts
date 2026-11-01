import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityCredentialTurn, bindAntigravityCredentialTurn, bindAntigravityTransportRetirement, prepareAntigravityRunnerCredentials } from "./antigravity-runner-credentials.js";
import { completeManagedNativeCredentialTurn } from "./managed-native-credentials.js";
import type { NativeSession, createRunnerdCodexTransport } from "../../vendor/paperclip-runner/index.js";
import { bindRetainedGoogleCredentialHome } from "../retained-google-credential-cleanup.js";

const copyFault = vi.hoisted(() => ({ phase: "", destination: "", source: "", collisionPath: "", failedRemoval: "", removals: [] as string[], hits: 0 }));
vi.mock("./runner-api-files.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./runner-api-files.js")>();
  return { ...actual, openRunnerWorkspaceFile: async (...args: Parameters<typeof actual.openRunnerWorkspaceFile>) => {
    const path = args[0];
    if (copyFault.phase === "stage-create" && copyFault.hits === 0 && path.includes("/.acp_token.copyback-") && (args[1] & constants.O_EXCL)) {
      copyFault.hits++; copyFault.collisionPath = path;
      await writeFile(path, "fixture-unowned-stage", { mode: 0o600, flag: "wx" });
    }
    const handle = await actual.openRunnerWorkspaceFile(...args);
    const staged = path.includes("/.acp_token.copyback-");
    const writable = staged || path === copyFault.destination;
    return new Proxy(handle, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return async (...callArgs: unknown[]) => {
        if (writable && copyFault.hits === 0 && copyFault.phase === "partial-write" && key === "write") {
          copyFault.hits++;
          await Reflect.apply(value, target, [callArgs[0], callArgs[1], Math.floor(Number(callArgs[2]) / 2), callArgs[3]]);
          throw new Error("fixture partial-write");
        }
        if (staged && copyFault.hits === 0 && copyFault.phase === "stage-stat" && key === "stat") {
          copyFault.hits++; throw new Error("fixture stage-stat");
        }
        if (writable && copyFault.hits === 0 && copyFault.phase === "stage-sync" && key === "sync") {
          copyFault.hits++; throw new Error("fixture stage-sync");
        }
        if (writable && copyFault.hits === 0 && copyFault.phase === "stage-close" && key === "close") {
          copyFault.hits++; await Reflect.apply(value, target, callArgs); throw new Error("fixture stage-close");
        }
        if (path === copyFault.destination.slice(0, copyFault.destination.lastIndexOf("/"))
          && copyFault.hits === 0 && copyFault.phase === "directory-sync" && key === "sync") {
          copyFault.hits++; throw new Error("fixture directory-sync");
        }
        if (path === copyFault.destination && copyFault.hits === 0 && copyFault.phase === "confirmation-change" && key === "sync") {
          copyFault.hits++; await writeFile(copyFault.destination, credential("fixture-concurrent"), { mode: 0o600 });
        }
        if (staged && copyFault.hits === 0 && copyFault.phase === "generation-change" && key === "sync") {
          copyFault.hits++; await writeFile(copyFault.destination, credential("fixture-concurrent"), { mode: 0o600 });
        }
        return Reflect.apply(value, target, callArgs);
      };
    } });
  } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[1]) === copyFault.destination && copyFault.hits === 0 && copyFault.phase.startsWith("rename-")) {
      copyFault.hits++;
      if (copyFault.phase === "rename-after") await actual.rename(...args);
      throw new Error("fixture " + copyFault.phase);
    }
    return actual.rename(...args);
  }, rm: async (...args: Parameters<typeof actual.rm>) => {
    const path = String(args[0]);
    if (path.includes("/.acp_token.copyback-")) copyFault.removals.push(path);
    if (copyFault.hits === 0 && ((copyFault.phase === "stage-remove" && path.includes("/.acp_token.copyback-"))
      || (copyFault.phase === "runtime-remove" && path === copyFault.source))) {
      copyFault.hits++; copyFault.failedRemoval = path;
      throw new Error("fixture " + copyFault.phase);
    }
    return actual.rm(...args);
  } };
});

const roots: string[] = [];
const credential = (token: string) => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
});
async function home() { const root = await realpath(await mkdtemp(join(tmpdir(), "antigravity-controller-test-"))); roots.push(root); await mkdir(join(root, "antigravity-acp"), { mode: 0o700 }); return root; }
beforeEach(async () => { vi.stubEnv("PAPERCLIP_HOME", await home()); });
afterEach(async () => { copyFault.phase = ""; copyFault.destination = ""; copyFault.source = ""; copyFault.collisionPath = ""; copyFault.failedRemoval = ""; copyFault.removals = []; copyFault.hits = 0; vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

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
  it.each(["turn completion", "direct close"])("retries original process proof after rejected %s before account reuse, without clearing session failure", async origin => {
    const managedHome = await home(), runtimeHome = await home();
    const release = bindRetainedGoogleCredentialHome(managedHome, { companyId: "company-retirement", accountKey: managedHome });
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    const terminal = Object.assign(new Error("fixture native session durable suspension failed"), { code: "native_session_close_unrecoverable" });
    const close = vi.fn(async () => { throw terminal; });
    let physicallyRetired = false;
    let releaseProof!: () => void;
    const proofGate = new Promise<void>(resolve => { releaseProof = resolve; });
    const proof = vi.fn(async () => {
      if (!physicallyRetired) throw new Error("fixture original process still alive");
      await proofGate;
    });
    const transport = bindAntigravityTransportRetirement({ transport: { close }, retireProbeResources: proof } as unknown as ReturnType<typeof createRunnerdCodexTransport>);
    const session = bindAntigravityCredentialTurn({ close: () => transport.close() } as unknown as NativeSession,
      { managedHome, runtimeHome, credential: credential("fixture-original") });
    try {
      await expect(origin === "turn completion" ? completeManagedNativeCredentialTurn(session) : session.close({ reason: "direct close" })).rejects.toBe(terminal);
      await expect(prepareAntigravityRunnerCredentials({ managedHome, remote: false, environment: {} }))
        .rejects.toThrow("still completing credential cleanup");
      expect(proof).toHaveBeenCalledOnce();
      expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
      expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
      physicallyRetired = true;
      const first = prepareAntigravityRunnerCredentials({ managedHome, remote: false, environment: {} });
      const second = prepareAntigravityRunnerCredentials({ managedHome, remote: false, environment: {} });
      let admitted = false;
      const preparing = Promise.all([first, second]).then(result => { admitted = true; return result; });
      await vi.waitFor(() => expect(proof).toHaveBeenCalledTimes(2));
      expect(admitted).toBe(false);
      expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
      releaseProof();
      const next = await preparing;
      expect(next.every(value => value.credential === credential("fixture-refreshed"))).toBe(true);
      expect(proof).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
      await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(session.close({ reason: "original session remains quarantined" })).rejects.toBe(terminal);
      expect(close).toHaveBeenCalledOnce();
    } finally { releaseProof(); release(); }
  });
  it.each(["partial-write", "stage-stat", "stage-sync", "stage-close", "rename-before", "rename-after", "directory-sync", "stage-remove", "runtime-remove"])(
    "retains an intact token and retries the retired owner after %s", async phase => {
      const managedHome = await home(), runtimeHome = await home();
      const directory = join(managedHome, "antigravity-acp"), destination = join(directory, "acp_token.json");
      const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
      const original = credential("fixture-original"), refreshed = credential("fixture-refreshed");
      await writeFile(destination, original, { mode: 0o600 });
      await writeFile(source, refreshed, { mode: 0o600 });
      const close = vi.fn(async () => {});
      const session = bindAntigravityCredentialTurn({ close } as unknown as NativeSession, { managedHome, runtimeHome, credential: original });
      const release = bindRetainedGoogleCredentialHome(managedHome, { companyId: "company-atomic", accountKey: managedHome });
      copyFault.phase = phase; copyFault.destination = destination; copyFault.source = source; copyFault.hits = 0;
      try {
        await expect(completeManagedNativeCredentialTurn(session)).rejects.toThrow("fixture " + phase);
        expect(copyFault.hits).toBe(1);
        expect(await readFile(destination, "utf8")).toBe(["rename-after", "directory-sync", "stage-remove", "runtime-remove"].includes(phase) ? refreshed : original);
        expect(await readFile(source, "utf8")).toBe(refreshed);
        expect((await stat(destination)).mode & 0o777).toBe(0o600);
        expect(await readdir(directory)).toEqual(["acp_token.json"]);
        copyFault.phase = "";
        const next = await prepareAntigravityRunnerCredentials({ managedHome, remote: false, environment: {} });
        expect(next.credential).toBe(refreshed);
        if (phase === "stage-remove") expect(copyFault.removals.filter(path => path === copyFault.failedRemoval)).toHaveLength(2);
        expect(close).toHaveBeenCalledOnce();
        await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(directory)).toEqual(["acp_token.json"]);
      } finally { copyFault.phase = ""; release(); }
    });
  it.each(["missing", "reset"])("retains staging cleanup when its runtime refresh is unexpectedly %s", async state => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    const original = credential("fixture-original"), refreshed = credential("fixture-refreshed");
    await writeFile(destination, original, { mode: 0o600 });
    await writeFile(source, refreshed, { mode: 0o600 });
    const turn = antigravityCredentialTurn({ managedHome, runtimeHome, credential: original });
    copyFault.phase = "stage-remove"; copyFault.destination = destination;
    await expect(turn.copyBack()).rejects.toThrow("fixture stage-remove");
    expect(await readFile(destination, "utf8")).toBe(refreshed);
    copyFault.phase = "";
    if (state === "missing") await rm(source);
    else await writeFile(source, original, { mode: 0o600 });
    await expect(turn.copyBack()).rejects.toThrow("handoff is invalid");
    await writeFile(source, refreshed, { mode: 0o600 });
    await turn.copyBack();
    expect(copyFault.removals.filter(path => path === copyFault.failedRemoval)).toHaveLength(2);
    await turn.remove();
    expect(await readFile(destination, "utf8")).toBe(refreshed);
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rechecks destination generation after staging without overwriting a concurrent credential", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const directory = join(managedHome, "antigravity-acp"), destination = join(directory, "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    copyFault.phase = "generation-change"; copyFault.destination = destination;
    await expect(antigravityCredentialTurn({ managedHome, runtimeHome, credential: credential("fixture-original") }).copyBack()).rejects.toThrow("destination changed");
    expect(copyFault.hits).toBe(1);
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-concurrent"));
    expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
    expect(await readdir(directory)).toEqual(["acp_token.json"]);
  });
  it("does not remove a staging file that it failed to create exclusively", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    copyFault.phase = "stage-create"; copyFault.destination = destination;
    const turn = antigravityCredentialTurn({ managedHome, runtimeHome, credential: credential("fixture-original") });
    await expect(turn.copyBack()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(copyFault.collisionPath, "utf8")).toBe("fixture-unowned-stage");
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
    expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
    copyFault.phase = "";
    await turn.copyBack();
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-refreshed"));
    expect(await readFile(copyFault.collisionPath, "utf8")).toBe("fixture-unowned-stage");
  });
  it("does not confirm a different generation after an uncertain successful rename", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    const source = join(runtimeHome, "antigravity-acp", "auth-refresh.json");
    await writeFile(destination, credential("fixture-refreshed"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    copyFault.phase = "confirmation-change"; copyFault.destination = destination;
    await expect(antigravityCredentialTurn({ managedHome, runtimeHome, credential: credential("fixture-original") }).copyBack()).rejects.toThrow("destination changed");
    expect(copyFault.hits).toBe(1);
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-concurrent"));
    expect(await readFile(source, "utf8")).toBe(credential("fixture-refreshed"));
  });
  it("rejects a hard-linked destination without changing either name", async () => {
    const managedHome = await home(), runtimeHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), other = join(managedHome, "other.json");
    await writeFile(other, credential("fixture-original"), { mode: 0o600 });
    await link(other, destination);
    await writeFile(join(runtimeHome, "antigravity-acp", "auth-refresh.json"), credential("fixture-refreshed"), { mode: 0o600 });
    await expect(antigravityCredentialTurn({ managedHome, runtimeHome, credential: credential("fixture-original") }).copyBack()).rejects.toThrow("destination is invalid");
    expect(await readFile(other, "utf8")).toBe(credential("fixture-original"));
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
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
