import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { AcpxRuntimeHost, type AcpxRuntimePort } from "./runtime-host.js";
import * as skillLease from "./runtime-skill-lease.js";
import { stageManagedHermesCredential } from "./hermes-credentials.js";

const roots: string[] = [];
const skillCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(skillCleanups.splice(0).map(close => close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const environment = { PAPERCLIP_HERMES_AUTH_JSON_SECRET: JSON.stringify({ version: 1, providers: { "openai-codex": { access_token: "fixture-token" } } }) };

describe("Hermes credential cleanup after verified provider exit", () => {
  it.each(["refresh", "collection", "both-cleanups", "provider-exit"])("cleans assigned skill copies without masking %s failures", async failure => {
    const root = await mkdtemp(join(tmpdir(), "hermes-host-cleanup-")); roots.push(root);
    const workspace = join(root, "workspace"), agent = join(root, "agent"), assigned = join(root, "assigned"), runtimeDirectory = join(root, "runtime");
    await Promise.all([workspace, agent, assigned, runtimeDirectory].map(path => mkdir(path)));
    await writeFile(join(assigned, "SKILL.md"), "Assigned skill fixture");
    const context = { instructions: { workingCopy: { kind: "agent_files", rootPath: agent, entryPath: "AGENTS.md" } },
      skills: [{ runtimeName: "assigned", bundle: { rootPath: assigned } }], mcp: {} } as unknown as NativeRuntimeContextSnapshot;
    let copiedRoot = "";
    const skillFailure = new Error("assigned skill cleanup failed");
    const createSkills = skillLease.createAcpxRuntimeSkillLease;
    const skillsClose = vi.fn(async () => undefined);
    vi.spyOn(skillLease, "createAcpxRuntimeSkillLease").mockImplementation(async context => {
      const lease = await createSkills(context);
      copiedRoot = lease.readRoots[0]!;
      skillCleanups.push(lease.close);
      skillsClose.mockImplementation(async () => {
        await lease.close();
        if (failure === "both-cleanups") throw skillFailure;
      });
      return { ...lease, close: skillsClose };
    });
    let failExit = failure === "provider-exit";
    const runtimeClose = vi.fn(async () => { if (failExit) throw new Error("provider exit unverified"); });
    const runtime: AcpxRuntimePort = {
      identity: async () => ({ acpxRecordId: "record", backendSessionId: "backend", agentSessionId: "agent" }),
      getStatus: async () => ({ models: { currentModelId: "hermes-fixture" } }),
      startTurn: () => { throw new Error("No model turn is allowed in this fixture"); },
      close: runtimeClose,
    };
    const host = await AcpxRuntimeHost.open({ runtimeDirectory, normalizedSessionId: "cleanup-session",
      workingDirectory: workspace, agent: "hermes", model: "hermes-fixture", permissionMode: "approve-all", runtimeContext: context,
      providerPolicy: { readOnly: false }, environment: { ...environment,
        PAPERCLIP_HERMES_CONNECTION_FINGERPRINT: "1".repeat(64),
        PAPERCLIP_HERMES_CONFIG_JSON: JSON.stringify({ model: { provider: "openrouter", default: "hermes-fixture" } }),
      } }, {
      verifyInstallation: async profile => ({ commandDigest: profile.commandDigest, agentServerPackageJsonPath: null,
        agentRuntimePackageJsonPath: null, openCommand: async () => ({ spawn: () => { throw new Error("No provider process is allowed"); }, close: async () => undefined }) }),
      openRuntime: async () => runtime, reportRetainedCleanupFailure: vi.fn(),
    });
    const home = join(host.runtimeRoot(), "hermes-home");
    expect(await readFile(join(copiedRoot, "assigned/SKILL.md"), "utf8")).toBe("Assigned skill fixture");
    if (failure === "refresh") await chmod(join(home, "auth.json"), 0o644);
    if (failure === "collection" || failure === "both-cleanups") await symlink(assigned, join(home, "memories/unsafe"));
    const error = await host.close({ reason: "fixture shutdown" }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(runtimeClose).toHaveBeenCalledOnce();
    if (failExit) {
      expect(skillsClose).not.toHaveBeenCalled();
      expect(await stat(copiedRoot)).toBeDefined();
      expect(await readFile(join(home, "auth.json"), "utf8")).toContain("fixture-token");
      failExit = false;
      await host.close({ reason: "verified provider shutdown" });
    }
    expect(skillsClose).toHaveBeenCalledOnce();
    await expect(stat(copiedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const errors = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
    if (failure === "both-cleanups") {
      expect(errors(error)).toContain(skillFailure);
      expect(errors(error).some(value => value instanceof Error && /bounded regular files/.test(value.message))).toBe(true);
    }
  });

  it.each(["refresh", "collection"])("scrubs credentials and releases ownership even when %s fails", async failure => {
    const home = await mkdtemp(join(tmpdir(), "hermes-credential-cleanup-")); roots.push(home);
    let failCollection = failure === "collection";
    const lease = await stageManagedHermesCredential({ agentHomeDirectory: home, environment,
      beforeRelease: async () => { if (failCollection) throw new Error("learned state rejected"); } });
    await mkdir(join(home, "logs"));
    await writeFile(join(home, "logs/native.log"), "private diagnostic fixture");
    if (failure === "refresh") await chmod(join(home, "auth.json"), 0o644);
    await expect(lease.close()).rejects.toThrow("Hermes state save or credential cleanup failed");
    await expect(readFile(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "logs/native.log"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, ".paperclip-auth-cleanup-required"))).rejects.toMatchObject({ code: "ENOENT" });
    failCollection = false;
    await lease.close();
    const next = await stageManagedHermesCredential({ agentHomeDirectory: home, environment, retainRefresh: () => false });
    await lease.close();
    expect(await readFile(join(home, "auth.json"), "utf8")).toContain("fixture-token");
    await next.close();
    await expect(readFile(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
