import { existsSync, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeExecutionInput } from "@paperclipai/paperclip-runner";
import { onNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { publishNativeHarnessBackup } from "./native-harness-backup-publication.js";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp, type NativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";

describe("native harness backup publication", () => {
  let backupRoot = "";
  let unsubscribe: (() => void) | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    unsubscribe?.(); unsubscribe = undefined;
    if (backupRoot) await fs.rm(backupRoot, { recursive: true, force: true });
  });
  async function fixture() {
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "native-backup-publication-"));
    const current = path.join(backupRoot, "current"), pendingRoot = path.join(backupRoot, "pending");
    await fs.mkdir(current); await fs.mkdir(pendingRoot);
    await fs.writeFile(path.join(current, "manifest.json"), "saved");
    await fs.writeFile(path.join(pendingRoot, "manifest.json"), "replacement");
    return { db: {}, companyId: "company", scopeDigest: "scope", backupRoot, pendingRoot, current };
  }
  async function scopedFixture(extension: boolean) {
    const { buildNativeHarnessBackupManifest, verifyNativeHarnessBackup } = await import("./native-session-executor.js");
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "native-backup-stamp-publication-"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", backupRoot);
    const release = { harnessId: "example.native/synthetic", packageName: "@example/plugin-harness", version: "1.0.0",
      integrity: `sha256-${Buffer.alloc(32, 1).toString("base64")}`, protocolVersion: 1, runtimeDigest: `sha256:${"a".repeat(64)}` };
    const execution = { provider: extension ? { kind: "extension", harnessId: release.harnessId, release, model: "fixture", config: { account: "credential-1" } }
      : { kind: "codex", model: "fixture", approvalPolicy: "never" },
      binding: { companyId: "company", agentId: "agent", agentKeyId: "epoch-1", runId: "run", issueId: "issue", executionWorkspaceId: "workspace" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: "native-session", driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as NativeExecutionInput;
    const sessionScopeId = JSON.stringify({ companyId: execution.binding.companyId, agentId: execution.binding.agentId,
      sessionId: execution.session.normalizedSessionId, workspaceId: execution.binding.executionWorkspaceId, provider: execution.provider });
    const scopeDigest = createHash("sha256").update(sessionScopeId).digest("hex");
    const storageRoot = path.join(backupRoot, ...(extension ? ["extension-session-backups"] : []), scopeDigest);
    const publishedRoot = path.join(storageRoot, "failover-backups"), pendingRoot = path.join(publishedRoot, "pending");
    for (const directory of ["runner", extension ? "extension" : "codex-home"]) {
      await fs.mkdir(path.join(pendingRoot, directory), { recursive: true });
      await fs.writeFile(path.join(pendingRoot, directory, "checkpoint.json"), JSON.stringify({ epoch: "epoch-1", release, account: "credential-1" }));
    }
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: pendingRoot, execution, runnerInstanceId: "runner-1",
      providerSessionIdentity: { providerSessionId: "native-thread", providerBackendSessionId: "native-backend" },
      sourceProviderLeaseId: "sandbox-source", completedAt: "2026-11-03T00:00:00.000Z" });
    await fs.writeFile(path.join(pendingRoot, "manifest.json"), JSON.stringify(manifest));
    const stampInput = { sessionScopeId, authorizedProviderLeaseId: "sandbox-source", normalizedSessionId: "native-session",
      runnerInstanceId: "runner-1", completedAt: manifest.completedAt };
    return { db: {}, companyId: "company", scopeDigest, backupRoot: publishedRoot, pendingRoot, storageRoot,
      stateBase: backupRoot, execution, manifest, stampInput, verifyNativeHarnessBackup };
  }

  it.each([false, true])("publishes and verifies scoped backups with extension layout %s", async extension => {
    const input = await scopedFixture(extension);
    const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    let stamp!: NativeHarnessBackupStamp;
    await publishNativeHarnessBackup({ ...input, stamp: async current => {
      stamp = createNativeHarnessBackupStamp({ ...input.stampInput, manifestPath: path.join(current, "manifest.json") });
      expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-source")).toBe(true);
    } });
    expect(changes).toEqual([{ companyId: input.companyId, scopeDigest: input.scopeDigest }]);
    expect(stamp.storageKind).toBe(extension ? "extension_session" : undefined);
    expect(verifyNativeHarnessBackupStamp(stamp, "foreign-lease")).toBe(false);
    expect(verifyNativeHarnessBackupStamp({ ...stamp, storageKind: "../foreign" }, "sandbox-source")).toBe(false);
    expect(verifyNativeHarnessBackupStamp({ ...stamp, storageKind: extension ? undefined : "extension_session" }, "sandbox-source")).toBe(false);
    expect(verifyNativeHarnessBackupStamp({ ...stamp, sessionScopeSha256: "f".repeat(64) }, "sandbox-source")).toBe(false);
    expect(verifyNativeHarnessBackupStamp({ ...stamp, sessionScopeSha256: "../foreign" }, "sandbox-source")).toBe(false);
    expect(() => createNativeHarnessBackupStamp({ ...input.stampInput, sessionScopeId: "foreign-scope",
      manifestPath: path.join(input.backupRoot, "current", "manifest.json") })).toThrow("scope_invalid");
    const foreignManifest = path.join(input.stateBase, "foreign-manifest.json");
    await fs.copyFile(path.join(input.backupRoot, "current", "manifest.json"), foreignManifest);
    expect(() => createNativeHarnessBackupStamp({ ...input.stampInput, manifestPath: foreignManifest })).toThrow("scope_invalid");
    expect(() => createNativeHarnessBackupStamp({ ...input.stampInput,
      manifestPath: path.join(input.backupRoot, "current") + "/../current/manifest.json" })).toThrow("scope_invalid");
    const verify = (execution = input.execution) => input.verifyNativeHarnessBackup({ root: input.storageRoot, execution, runnerInstanceId: "runner-1" });
    expect(verify()).not.toBeNull();
    for (const binding of [{ companyId: "foreign-company" }, { agentId: "foreign-agent" }, { agentKeyId: "epoch-2" }]) {
      expect(verify({ ...input.execution, binding: { ...input.execution.binding, ...binding } })).toBeNull();
    }
    expect(verify({ ...input.execution, session: { ...input.execution.session, normalizedSessionId: "foreign-session" } })).toBeNull();
    if (input.execution.provider.kind === "extension") {
      expect(verify({ ...input.execution, provider: { ...input.execution.provider, config: { account: "credential-2" } } })).toBeNull();
      expect(verify({ ...input.execution, provider: { ...input.execution.provider, release: { ...input.execution.provider.release, version: "2.0.0" } } })).toBeNull();
    }
    const previous = path.join(input.backupRoot, "previous");
    await fs.rename(path.join(input.backupRoot, "current"), previous);
    expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-source")).toBe(true);
    expect(verify()?.root).toBe(previous);
    await fs.writeFile(path.join(previous, "runner", "checkpoint.json"), "tampered");
    expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-source")).toBe(false);
    expect(verify()).toBeNull();
  }, 30_000);

  it.each(["namespace", "scope", "backup-parent", "candidate", "manifest"])("rejects extension backup %s symlinks after publication", async component => {
    const input = await scopedFixture(true);
    let stamp!: NativeHarnessBackupStamp;
    await publishNativeHarnessBackup({ ...input, stamp: async current => {
      stamp = createNativeHarnessBackupStamp({ ...input.stampInput, manifestPath: path.join(current, "manifest.json") });
    } });
    const current = path.join(input.backupRoot, "current");
    const target = component === "namespace" ? path.dirname(input.storageRoot) : component === "scope" ? input.storageRoot
      : component === "backup-parent" ? input.backupRoot : component === "candidate" ? current : path.join(current, "manifest.json");
    const foreign = path.join(input.stateBase, `foreign-${component}`);
    await fs.rename(target, foreign);
    await fs.symlink(foreign, target, component === "manifest" ? "file" : "junction");
    expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-source")).toBe(false);
    expect(() => createNativeHarnessBackupStamp({ ...input.stampInput, manifestPath: path.join(current, "manifest.json") })).toThrow("scope_invalid");
    expect(() => createNativeHarnessBackupStamp({ ...input.stampInput, manifestPath: path.join(foreign, "manifest.json") })).toThrow("scope_invalid");
  }, 30_000);

  it("restores the existing backup when its lease stamp fails without publishing a false change", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    await expect(publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
      throw new Error("stamp transaction rejected");
    } })).rejects.toThrow("stamp transaction rejected");
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("saved");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]); expect(changes).toEqual([]);
  });
  it("publishes the completed replacement once and removes its predecessor", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    const previous = path.join(backupRoot, "previous");
    for (const root of [input.current, previous]) {
      const skill = path.join(root, "skills", "immutable");
      await fs.mkdir(skill, { recursive: true });
      await fs.writeFile(path.join(skill, "SKILL.md"), "saved instructions", { mode: 0o444 });
      await fs.chmod(skill, 0o555);
    }
    unsubscribe = onNativeHarnessBackupChange(input.db, change => {
      expect(existsSync(previous)).toBe(false);
      changes.push(change);
    });
    await publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(changes).toEqual([]);
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
    } });
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]);
    expect(changes).toEqual([{ companyId: input.companyId, scopeDigest: input.scopeDigest }]);
  });
  it("serves an unrelated request while a retired backup is being removed", async () => {
    const input = await fixture();
    for (let index = 0; index < 40; index++) {
      const directory = path.join(input.current, `skill-${index}`);
      await fs.mkdir(directory);
      await Promise.all(Array.from({ length: 50 }, (_, file) =>
        fs.writeFile(path.join(directory, `file-${file}`), "retired instructions", { mode: 0o444 })));
      await fs.chmod(directory, 0o555);
    }
    let publishing = false;
    let probeReceived: (response: ServerResponse | null) => void;
    const probeReady = new Promise<ServerResponse | null>(resolve => { probeReceived = resolve; });
    const server = createServer((request, response) => {
      if (request.url === "/probe") { probeReceived(response); return; }
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP probe did not start");
    const client = spawn(process.execPath, ["--input-type=module", "-e", `
      import { Agent, get } from "node:http";
      const agent = new Agent({ keepAlive: true });
      const request = path => new Promise((resolve, reject) => {
        get({ hostname: "127.0.0.1", port: Number(process.argv[1]), path, agent }, response => {
          response.resume();
          response.on("end", () => resolve(response.headers["x-publication-active"]));
        }).on("error", reject);
      });
      await request("/");
      process.send({ kind: "ready" });
      process.once("message", async () => {
        const active = await request("/probe");
        process.send({ kind: "result", active }, () => { agent.destroy(); process.disconnect(); });
      });
    `, String(address.port)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const message = (kind: string) => new Promise<{ active?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`HTTP probe ${kind} timed out`)); }, 10_000);
      const received = (value: { kind?: string; active?: string }) => {
        if (value.kind === kind) { cleanup(); resolve(value); }
      };
      const failed = () => { cleanup(); reject(new Error(`HTTP probe exited before ${kind}`)); };
      const cleanup = () => {
        clearTimeout(timer); client.off("message", received); client.off("exit", failed); client.off("error", failed);
      };
      client.on("message", received); client.once("exit", failed); client.once("error", failed);
    });
    let publication: Promise<void> | undefined;
    try {
      await message("ready");
      const response = message("result");
      publishing = true;
      publication = publishNativeHarnessBackup({
        ...input,
        stamp: async () => {
          client.send({ kind: "probe" });
          const response = await probeReady;
          if (!response) return;
          setImmediate(() => {
            response.setHeader("x-publication-active", publishing ? "1" : "0");
            response.end("ok");
          });
        },
      }).finally(() => { publishing = false; });
      const result = await response;
      await publication;
      expect(result.active).toBe("1");
      expect(await fs.readdir(backupRoot)).toEqual(["current"]);
      expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
    } finally {
      probeReceived!(null);
      try { await publication; }
      finally {
        client.kill();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  }, 15_000);
});
