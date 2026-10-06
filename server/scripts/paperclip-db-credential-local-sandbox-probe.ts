// Runs only inside the disposable Bubblewrap test container. No secret values are logged.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildLocalProcessSandboxSpawnTarget } from "../../packages/adapter-utils/src/local-process-sandbox.js";
import {
  assertFileBackedDbAgentExecutionAllowed,
  runAdapterExecutionTargetProcess,
} from "../../packages/adapter-utils/src/execution-target.js";
import { buildPaperclipEnv } from "../../packages/adapter-utils/src/server-utils.js";
import { stageCodexHomeForSync } from "../../packages/adapters/codex-local/src/server/codex-home.js";

const workspaceDir = process.env.WORKSPACE_DIR;
const credentialPath = process.env.PAPERCLIP_DATABASE_URL_FILE;
const apiKey = process.env.PAPERCLIP_API_KEY;
const runId = process.env.PAPERCLIP_RUN_ID;
const agentId = process.env.EXPECTED_AGENT_ID;
const companyId = process.env.PAPERCLIP_COMPANY_ID;
const effectiveCaps = readFileSync("/proc/self/status", "utf8").match(/^CapEff:\s*([0-9a-f]+)$/m);
if (!effectiveCaps || BigInt(`0x${effectiveCaps[1]}`) !== (1n << 21n)) {
  throw new Error("Unexpected smoke container effective capability set");
}
if (!workspaceDir || !credentialPath || !apiKey || !runId || !agentId || !companyId ||
    !process.env.PAPERCLIP_AGENT_JWT_SECRET) {
  throw new Error("Missing synthetic service source or run identity");
}
const serviceUrl = readFileSync(credentialPath, "utf8").trim();
if (!serviceUrl.startsWith("postgres://")) {
  throw new Error("Synthetic service credential is not readable before agent launch");
}

const env = {
  ...buildPaperclipEnv({ id: agentId, companyId }),
  PAPERCLIP_API_KEY: apiKey,
  PAPERCLIP_RUN_ID: runId,
  EXPECTED_AGENT_ID: agentId,
  EXPECTED_SERVICE_UID: String(process.getuid?.() ?? -1),
  KNOWN_CREDENTIAL_PATH: credentialPath,
  EXPECTED_CREDENTIAL_VISIBILITY: "hidden",
};
const target = { kind: "local" } as const;
const options = {
  cwd: workspaceDir,
  env,
  timeoutSec: 20,
  graceSec: 2,
  onLog: async () => {},
};

for (const [label, attempt] of [
  ["unconfined local", () => runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], options)],
  ["local network-only", () => runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options, localProcessSandbox: { workspaceDir, networkScope: "deny" as const },
  })],
] as const) {
  try {
    await attempt();
    throw new Error(`${label} unexpectedly launched`);
  } catch (error) {
    if (!String(error).includes("require a workspace filesystem sandbox")) throw error;
  }
  console.log(`${label}: denied before agent launch`);
}
try {
  assertFileBackedDbAgentExecutionAllowed(target, null, "acpx");
  throw new Error("local ACPX unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("require ACPX to run in an isolated remote environment")) throw error;
}
console.log("unconfined ACPX: denied before agent launch");

try {
  await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options,
    env: { ...env, PAPERCLIP_DATABASE_URL_FILE: credentialPath },
    localProcessSandbox: { workspaceDir, filesystemScope: "workspace" },
  });
  throw new Error("explicit database source unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("must not contain control-plane database or signing credentials")) throw error;
}
console.log("explicit DB source: denied before agent launch");

try {
  await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options,
    localProcessSandbox: {
      workspaceDir,
      filesystemScope: "workspace",
      extraPaths: [{ path: dirname(credentialPath), access: "ro" }],
    },
  });
  throw new Error("credential mount unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("mount would expose the service database credential")) throw error;
}
console.log("credential-bearing mount: denied before agent launch");

const substitutedLauncher = join(workspaceDir, "fake-bwrap");
const substitutedMarker = join(workspaceDir, "fake-bwrap-ran");
await fs.writeFile(substitutedLauncher, `#!/bin/sh\ntouch '${substitutedMarker}'\nexit 0\n`, { mode: 0o700 });
try {
  await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
    ...options,
    localProcessSandbox: { workspaceDir, filesystemScope: "workspace", command: substitutedLauncher },
  });
  throw new Error("substituted Bubblewrap unexpectedly allowed");
} catch (error) {
  if (!String(error).includes("trusted /usr/bin/bwrap launcher")) throw error;
}
if (await fs.stat(substitutedMarker).then(() => true).catch(() => false)) {
  throw new Error("substituted Bubblewrap executed before sandboxing");
}
console.log("substituted Bubblewrap: denied before launcher execution");

const pathLauncher = join(workspaceDir, "bwrap");
const pathMarker = join(workspaceDir, "path-bwrap-ran");
await fs.writeFile(pathLauncher, `#!/bin/sh\ntouch '${pathMarker}'\nexit 0\n`, { mode: 0o700 });

const result = await runAdapterExecutionTargetProcess(runId, target, "python3", [join(workspaceDir, "agent-probe.py")], {
  ...options,
  env: { ...env, PATH: `${workspaceDir}:/usr/bin:/bin`, LD_PRELOAD: "/synthetic/missing-preload.so" },
  localProcessSandbox: { workspaceDir, filesystemScope: "workspace" },
});
if (await fs.stat(pathMarker).then(() => true).catch(() => false)) {
  throw new Error("PATH-selected Bubblewrap executed before sandboxing");
}
if (result.exitCode !== 0 || !result.stdout.includes("Launched agent: credential read denied; DB/signing env keys 0; JWT API HTTP 200")) {
  const diagnostic = result.stderr.replaceAll(serviceUrl, "[redacted database URL]")
    .replaceAll(new URL(serviceUrl).password, "[redacted password]")
    .replaceAll(apiKey, "[redacted API token]")
    .replaceAll(process.env.PAPERCLIP_AGENT_JWT_SECRET!, "[redacted signing key]")
    .split("\n").filter(Boolean).slice(-5).join("; ");
  throw new Error(`workspace sandbox agent check failed (exit ${result.exitCode ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
}
if (result.stderr.includes("missing-preload.so")) {
  throw new Error("Agent-supplied dynamic loader environment reached Bubblewrap");
}
console.log("workspace sandbox: trusted Bubblewrap despite agent PATH; loader override stripped; credential path hidden; DB/signing env keys 0; JWT API HTTP 200");

// The agent cannot read the synthetic service credential in Bubblewrap, but
// can plant a link in its writable CODEX_HOME. A later host-side remote-home
// staging pass must reject that link before any sandbox asset is prepared.
const codexHome = await fs.mkdtemp(join(tmpdir(), "paperclip-codex-home-agent-"));
const serviceOnlyHome = await fs.mkdtemp(join(tmpdir(), "paperclip-codex-service-only-"));
const aliasMarker = "SYNTHETIC_SERVICE_ALIAS_SECRET";
await fs.mkdir(join(serviceOnlyHome, "home"), { mode: 0o700 });
await fs.writeFile(join(serviceOnlyHome, "home", "instructions.md"), aliasMarker, { mode: 0o600 });
const linkScript = join(workspaceDir, "plant-codex-home-link.py");
await fs.writeFile(linkScript, `from pathlib import Path
import os
import runpy
home = Path(os.environ["CODEX_HOME"])
credential = Path(os.environ["KNOWN_CREDENTIAL_PATH"])
if credential.exists():
    raise RuntimeError("service credential became visible in Bubblewrap")
alias_target = Path(os.environ["KNOWN_ALIAS_TARGET"])
if alias_target.exists():
    raise RuntimeError("service-only alias target became visible in Bubblewrap")
(home / "instructions.md").symlink_to(credential)
agent_writable = home / "agent-writable"
agent_writable.mkdir(mode=0o700)
(agent_writable / "volume").symlink_to(alias_target, target_is_directory=True)
runpy.run_path(str(Path(os.environ["WORKSPACE_DIR"]) / "agent-probe.py"), run_name="__main__")
print("codex-home links planted without service-only read")
`, { mode: 0o600 });
try {
  const planted = await runAdapterExecutionTargetProcess(runId, target, "python3", [linkScript], {
    ...options,
    env: { ...env, CODEX_HOME: codexHome, WORKSPACE_DIR: workspaceDir, KNOWN_ALIAS_TARGET: serviceOnlyHome },
    localProcessSandbox: {
      workspaceDir,
      filesystemScope: "workspace",
      managedPaths: [{ path: codexHome, access: "rw" }],
      homeDir: codexHome,
    },
  });
  if (planted.exitCode !== 0 ||
      !planted.stdout.includes("codex-home links planted without service-only read") ||
      !planted.stdout.includes("JWT API HTTP 200") ||
      !(await fs.lstat(join(codexHome, "instructions.md"))).isSymbolicLink() ||
      !(await fs.lstat(join(codexHome, "agent-writable", "volume"))).isSymbolicLink()) {
    throw new Error("Bubblewrap agent did not plant the CODEX_HOME links and retain JWT access");
  }
  const agentWritableStat = await fs.stat(join(codexHome, "agent-writable"));
  const aliasFileStat = await fs.stat(join(serviceOnlyHome, "home", "instructions.md"));
  if (agentWritableStat.uid !== process.getuid?.() ||
      (agentWritableStat.mode & 0o777) !== 0o700 ||
      (aliasFileStat.mode & 0o777) !== 0o600) {
    throw new Error("Directory alias fixture lacks the shared UID and private modes");
  }
  const stagePrefix = `paperclip-codex-home-sync-${runId}-`;
  const stagesBefore = (await fs.readdir(tmpdir())).filter((name) => name.startsWith(stagePrefix));
  let refused = false;
  try {
    await stageCodexHomeForSync(codexHome, { runId, authSourcePaths: [], skillSources: [] });
  } catch (error) {
    const message = String(error);
    if (message.includes(serviceUrl) || !message.includes("not a regular file")) {
      throw new Error("Remote Codex home staging produced an unsafe diagnostic");
    }
    refused = true;
  }
  if (!refused) throw new Error("Remote Codex home staging followed the planted service link");
  const stagesAfter = (await fs.readdir(tmpdir())).filter((name) => name.startsWith(stagePrefix));
  if (stagesAfter.length !== stagesBefore.length) {
    throw new Error("Rejected remote Codex home staging left a partial asset");
  }
  console.log("codex-home remote staging: planted service link denied; partial asset 0; credential bytes/log 0; JWT API HTTP 200");

  refused = false;
  try {
    await stageCodexHomeForSync(join(codexHome, "agent-writable", "volume", "home"), {
      runId, authSourcePaths: [], skillSources: [],
    });
  } catch (error) {
    const message = String(error);
    if (message.includes(aliasMarker) || message.includes(serviceUrl) ||
        !message.includes("untrusted directory symlink")) {
      throw new Error("Directory alias staging produced an unsafe diagnostic");
    }
    refused = true;
  }
  if (!refused) throw new Error("Remote Codex home staging followed the agent-planted directory alias");
  const stagesAfterAlias = (await fs.readdir(tmpdir())).filter((name) => name.startsWith(stagePrefix));
  if (stagesAfterAlias.length !== stagesBefore.length) {
    throw new Error("Rejected directory alias staging left a partial asset");
  }
  console.log("codex-home directory alias: same-UID 0700 parent denied; partial asset 0; credential bytes/log 0; JWT API HTTP 200");

  await fs.unlink(join(codexHome, "instructions.md"));
  const sharedAuth = join(workspaceDir, "synthetic-shared-auth.json");
  const skillSource = join(workspaceDir, "synthetic-skill");
  await fs.writeFile(sharedAuth, '{"OPENAI_API_KEY":"synthetic-only"}\n', { mode: 0o600 });
  await fs.mkdir(skillSource);
  await fs.writeFile(join(skillSource, "SKILL.md"), "# Synthetic skill\n", { mode: 0o600 });
  await fs.mkdir(join(codexHome, "skills"));
  await fs.symlink(sharedAuth, join(codexHome, "auth.json"));
  await fs.symlink(skillSource, join(codexHome, "skills", "synthetic-skill"));
  const staged = await stageCodexHomeForSync(codexHome, {
    runId,
    authSourcePaths: [sharedAuth],
    skillSources: [{ name: "synthetic-skill", source: skillSource }],
  });
  try {
    if ((await fs.lstat(join(staged, "auth.json"))).isSymbolicLink() ||
        (await fs.readFile(join(staged, "auth.json"), "utf8")) !== '{"OPENAI_API_KEY":"synthetic-only"}\n' ||
        (await fs.readFile(join(staged, "skills", "synthetic-skill", "SKILL.md"), "utf8")) !== "# Synthetic skill\n") {
      throw new Error("Bound auth and selected skill were not staged as regular content");
    }
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
  console.log("codex-home positive staging: bound auth and selected skill copied; JWT API HTTP 200");
} finally {
  await fs.rm(codexHome, { recursive: true, force: true });
  await fs.rm(serviceOnlyHome, { recursive: true, force: true });
  await fs.rm(join(workspaceDir, "synthetic-skill"), { recursive: true, force: true });
  await fs.rm(join(workspaceDir, "synthetic-shared-auth.json"), { force: true });
  await fs.rm(linkScript, { force: true });
}

const aliasSource = join(workspaceDir, "alias-source");
const preservedAlias = join(workspaceDir, "preserved-alias-source");
await fs.mkdir(aliasSource);
await fs.writeFile(join(aliasSource, "allowed-marker"), "safe");
const aliasTarget = await buildLocalProcessSandboxSpawnTarget({
  executable: "/usr/bin/python3",
  args: ["-c", `from pathlib import Path
alias = Path('/checked-alias')
if (alias / 'allowed-marker').read_text() != 'safe':
    raise RuntimeError('alias did not bind the checked directory')
if (alias / 'database-url').exists():
    raise RuntimeError('alias exposed the service credential')
print('alias race: pinned directory visible; credential read denied')`],
  cwd: workspaceDir,
  options: {
    workspaceDir,
    filesystemScope: "workspace",
    pathAliases: [{ path: "/checked-alias", target: aliasSource }],
  },
});
try {
  // Swap the canonical source after target construction and before bwrap spawn.
  await fs.rename(aliasSource, preservedAlias);
  await fs.symlink(dirname(credentialPath), aliasSource);
  const aliasResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(aliasTarget.command, aliasTarget.args, {
      cwd: aliasTarget.cwd,
      env: { PATH: "/usr/bin:/bin", HOME: workspaceDir },
      stdio: ["ignore", "pipe", "pipe", ...(aliasTarget.inheritedFds ?? [])],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (aliasResult.code !== 0 || !aliasResult.stdout.includes("alias race: pinned directory visible; credential read denied")) {
    throw new Error(`alias race sandbox failed (exit ${aliasResult.code ?? "unknown"}): ${aliasResult.stderr.slice(-400)}`);
  }
  console.log("alias race: pinned directory visible; credential read denied");
} finally {
  await aliasTarget.cleanup?.();
  await fs.rm(aliasSource, { recursive: true, force: true });
  await fs.rm(preservedAlias, { recursive: true, force: true });
}
