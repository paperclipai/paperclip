import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunTrace } from "./native-run-trace.js";

type StageAsset = {
  sourcePath: string;
  targetPath: string;
  mode: number;
};

type LaunchAssetsInput = {
  root: string;
  transport: "ssh" | "sandbox";
  runner: CommandManagedRuntimeRunner;
  persistenceDirectories: readonly {
    name: string;
    location: "runner" | "filesystem";
    targetPath: string | null;
  }[];
  runtimeContext: {
    source: NativeRuntimeContextSnapshot;
    target: NativeRuntimeContextSnapshot;
    filesystemRoot: string;
  } | null;
  caBundleMapping: { sourcePath: string; targetPath: string } | null;
  stageFile: (input: StageAsset) => Promise<void>;
  stageDirectory: (input: StageAsset) => Promise<void>;
  isolatedCodexSkills?: { workspaceRoot: string };
  trace?: NativeRunTrace;
};

async function assertSelectedSkillsTree(root: string, names: string[]): Promise<void> {
  const found = new Set<string>();
  const reject = () => { throw new Error("runner_remote_codex_skills_invalid"); };
  async function visit(relativePath: string) {
    const path = relativePath ? resolve(root, relativePath) : root;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) reject();
    if (stat.isDirectory()) {
      if (relativePath && !names.some(name => relativePath === name || relativePath.startsWith(`${name}/`) || name.startsWith(`${relativePath}/`))) reject();
      for (const entry of await readdir(path)) await visit(relativePath ? `${relativePath}/${entry}` : entry);
    } else {
      if (!stat.isFile() || (stat.mode & 0o222) !== 0 || !names.some(name => relativePath.startsWith(`${name}/`))) reject();
      for (const name of names) if (relativePath === `${name}/SKILL.md`) found.add(name);
    }
  }
  await visit("");
  if (found.size !== names.length) reject();
}

// Launch preparation owns this isolated directory and runs only after the old
// provider has stopped. Never follow a retained symlink while removing stale
// assignments; auth, config and provider conversation history are not touched.
const clearRemoteCodexSkills = `
const fs = require("node:fs"), path = require("node:path");
const home = path.resolve(process.argv[1]), workspace = path.resolve(process.argv[2]);
const relative = path.relative(workspace, home);
if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error("unsafe_codex_home");
// The execution target authorizes the workspace anchor. Resolve only that
// anchor (which can have an OS alias), then refuse links below it.
let current = fs.realpathSync(workspace);
if (!fs.lstatSync(current).isDirectory()) throw Error("unsafe_workspace_root");
for (const segment of relative.split(path.sep)) {
  current = path.join(current, segment);
  if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current, { mode: 0o700 });
  const stat = fs.lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe_codex_home");
}
const skills = path.join(current, "skills");
function unseal(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("unsafe_skills_root");
  fs.chmodSync(directory, 0o700);
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name), stat = fs.lstatSync(child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) unseal(child);
  }
}
if (fs.lstatSync(skills, { throwIfNoEntry: false })) {
  unseal(skills);
  fs.rmSync(skills, { recursive: true });
}
// Native directory transfers omit the source root and may ignore its mapping
// mode. Create the private discovery root before their mkdir/extract step.
fs.mkdirSync(skills, { mode: 0o700 });
fs.chmodSync(skills, 0o700);
`;

export async function stageRemoteLaunchAssets(input: LaunchAssetsInput): Promise<void> {
  const measure = async (name: string, operation: () => Promise<void>) =>
    input.trace ? input.trace.measure(name, operation) : operation();
  const materializeLaunchState = () => measure("harness_state.launch_material", async () => {
    for (const directory of input.persistenceDirectories) {
      if (directory.location !== "filesystem") continue;
      const targetPath = directory.targetPath;
      if (!targetPath) throw new Error("runner_harness_state_mismatch: bootstrap_target_unavailable");
      const escapedTarget = targetPath.replaceAll("'", "'\\''");
      const created = await input.runner.execute({
        command: "sh",
        args: ["-c", `umask 077; install -d -m 0700 '${escapedTarget}'`],
        bypassSession: true,
        timeoutMs: 10_000,
      });
      if (created.exitCode !== 0 || created.timedOut) {
        throw new Error("runner_remote_directory_staging_failed");
      }
      if (directory.name !== "codex-home") continue;
      const localDirectory = resolve(input.root, directory.name);
      for (const name of ["auth.json", "config.toml"] as const) {
        const sourcePath = resolve(localDirectory, name);
        if (!existsSync(sourcePath)) continue;
        await input.stageFile({ sourcePath, targetPath: posix.join(targetPath, name), mode: 0o600 });
      }
    }
  });
  const stageRuntimeContext = async () => {
    const context = input.runtimeContext;
    if (!context) return;
    await measure("stage.asset.runtime_context", async () => {
      await input.stageDirectory({
        sourcePath: context.source.instructions.bundle.rootPath,
        targetPath: context.target.instructions.bundle.rootPath,
        mode: 0o555,
      });
      for (let index = 0; index < context.source.skills.length; index += 1) {
        await input.stageDirectory({
          sourcePath: context.source.skills[index]!.bundle.rootPath,
          targetPath: context.target.skills[index]!.bundle.rootPath,
          mode: 0o555,
        });
      }
      await input.stageFile({
        sourcePath: resolve(input.root, "runtime-context.json"),
        targetPath: posix.join(context.filesystemRoot, "runtime-context.json"),
        mode: 0o600,
      });
    });
  };
  const stageCodexSkills = async () => {
    if (!input.isolatedCodexSkills) return;
    const directory = input.persistenceDirectories.find(entry => entry.name === "codex-home" && entry.location === "filesystem");
    if (!directory?.targetPath) throw new Error("runner_harness_state_mismatch: bootstrap_target_unavailable");
    const sourcePath = resolve(input.root, "codex-home", "skills");
    await assertSelectedSkillsTree(sourcePath, input.runtimeContext?.source.skills.map(skill => skill.runtimeName) ?? []);
    await measure("stage.asset.codex_skills", async () => {
      const cleared = await input.runner.execute({
        command: "node",
        args: ["-e", clearRemoteCodexSkills, directory.targetPath!, input.isolatedCodexSkills!.workspaceRoot],
        bypassSession: true,
        timeoutMs: 10_000,
      });
      if (cleared.exitCode !== 0 || cleared.timedOut) throw new Error("runner_remote_codex_skills_reset_failed");
      // Match prepareIsolatedCodexHome: the discovery root is private/writable
      // for Codex's own built-ins; each selected package remains sealed.
      await input.stageDirectory({ sourcePath, targetPath: posix.join(directory.targetPath!, "skills"), mode: 0o700 });
    });
  };
  // Resolve the owned home and remove obsolete assignments before any launch
  // file can be written through a retained, redirected path.
  await stageCodexSkills();
  if (input.transport === "sandbox" && input.runner.allowConcurrentSyncOperations === true) {
    const outcomes = await Promise.allSettled([materializeLaunchState(), stageRuntimeContext()]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
  } else {
    await materializeLaunchState();
    await stageRuntimeContext();
  }
  if (input.caBundleMapping) {
    const mapping = input.caBundleMapping;
    await measure("stage.asset.ca_bundle", () => input.stageFile({ ...mapping, mode: 0o600 }));
  }
}
