import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as credentials from "./codex-credentials.js";
import * as skills from "./runtime-skill-lease.js";
import * as bridge from "../runner-tool-bridge.js";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { inventoryPiRuntimeFiles, verifyPiRuntimeLayoutForNativeSnapshot, type PiRuntimeManifest } from "./pi-verified-runtime.js";
import { AcpxRuntimeHost } from "./runtime-host.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("rejects corrupt Pi bytes at the command boundary before runtime, spawn or bridge and releases lifetime/skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-admission-")); roots.push(root);
  const source = join(root, "provider"); const workspace = join(root, "workspace");
  await mkdir(source); await mkdir(workspace); await mkdir(join(root, "runtime"));
  for (const name of ["node", "pi.js", "extension.js", "wrapper.js"]) await writeFile(join(source, name), "pinned:" + name);
  await chmod(join(source, "node"), 0o500);
  const manifest: PiRuntimeManifest = { schema: "paperclip.pi-runtime-files.v1", node: "node", piEntrypoint: "pi.js", extension: "extension.js", wrapperEntrypoint: "wrapper.js", files: await inventoryPiRuntimeFiles(source) };
  const entries = await Promise.all(manifest.files.map(async entry => ({ path: entry.path, sha256: entry.sha256.slice(7), size: (await lstat(join(source, entry.path))).size, executable: entry.path === "node" })));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const closure = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const manifestPath = join(root, "native.json"); await writeFile(manifestPath, JSON.stringify({ entries }));
  const installation = await verifyNativeAcpxInstallation({ distributionRoot: source, manifestPath, expectedClosureSha256: closure, executable: "node", entrypoint: "wrapper.js", fixedArguments: [] });
  await writeFile(join(source, "wrapper.js"), "x".repeat(entries.find(entry => entry.path === "wrapper.js")!.size));
  // Declaration/layout resolution intentionally does not claim byte admission.
  await verifyPiRuntimeLayoutForNativeSnapshot(source, manifest, { entries }, closure);
  const lifetimeCloses: ReturnType<typeof vi.fn>[] = []; const skillCloses: ReturnType<typeof vi.fn>[] = [];
  const acquireLifetime = credentials.acquireAcpxProviderLifetimeLease;
  vi.spyOn(credentials, "acquireAcpxProviderLifetimeLease").mockImplementation(async input => {
    const lease = await acquireLifetime(input); const close = vi.fn(() => lease.close()); lifetimeCloses.push(close);
    return { ...lease, close };
  });
  const acquireSkills = skills.createAcpxRuntimeSkillLease;
  vi.spyOn(skills, "createAcpxRuntimeSkillLease").mockImplementation(async input => {
    const lease = await acquireSkills(input); const close = vi.fn(() => lease.close()); skillCloses.push(close);
    return { ...lease, close };
  });
  const toolBridge = vi.spyOn(bridge, "startRunnerToolBridge");
  const openRuntime = vi.fn(); const spawn = vi.fn();
  const openCommand = vi.fn(async () => {
    const lease = await installation.openCommand();
    return { close: () => lease.close(), spawn };
  });
  await expect(AcpxRuntimeHost.open({
    runtimeDirectory: join(root, "runtime"), normalizedSessionId: "pi-single-pass-rejection",
    workingDirectory: workspace, agent: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731",
    permissionMode: "approve-all", providerPolicy: { readOnly: true },
    semanticTools: { tools: [], handler: vi.fn() },
  }, {
    verifyInstallation: async profile => ({ commandDigest: profile.commandDigest, agentServerPackageJsonPath: join(source, "package.json"), agentRuntimePackageJsonPath: null, openCommand }),
    openRuntime, reportRetainedCleanupFailure: vi.fn(),
  })).rejects.toThrow("digest mismatch");
  expect(openCommand).toHaveBeenCalledOnce();
  expect(openRuntime).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(toolBridge).not.toHaveBeenCalled();
  expect(lifetimeCloses).toHaveLength(1); expect(lifetimeCloses[0]).toHaveBeenCalledOnce();
  expect(skillCloses).toHaveLength(1); expect(skillCloses[0]).toHaveBeenCalledOnce();
  expect(lifetimeCloses[0]!.mock.invocationCallOrder[0]).toBeLessThan(skillCloses[0]!.mock.invocationCallOrder[0]!);
});
