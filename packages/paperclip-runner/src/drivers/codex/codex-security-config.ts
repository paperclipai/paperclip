import { configuredEnvironmentKeys } from "../../configured-environment.js";
import { resolve, isAbsolute, join, dirname, delimiter, relative, sep } from "node:path";
import { closeSync, constants, existsSync, fstatSync, openSync, realpathSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { QUALIFIED_ACPX_PROFILES } from "../acpx/qualified-profiles.js";

import {
  githubCredentialEnvironmentKeys,
} from "../../github-credential-environment.js";

/** DNS and CA files can point outside the minimal /etc filesystem (systemd). */
export function codexNetworkReadOnlyRoots(source: NodeJS.ProcessEnv): string[] {
  if (!codexNetworkAccess(source)) return [];
  const roots = new Set<string>();
  if (source.PAPERCLIP_RUNNER_NETWORK_ROOTS !== undefined) {
    try {
      const projected: unknown = JSON.parse(source.PAPERCLIP_RUNNER_NETWORK_ROOTS);
      if (Array.isArray(projected)) for (const root of projected) {
        if (typeof root === "string" && isAbsolute(root) && resolve(root) !== "/") roots.add(resolve(root));
      }
    } catch { /* A malformed controller projection must not expand access. */ }
  } else {
    for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs", "/etc/ssl/cert.pem"]) {
      try { roots.add(realpathSync(file)); } catch { /* Platform-specific optional resource. */ }
    }
  }
  return [...roots];
}

/** Resolve executable resources only, without exposing their enclosing home. */
export function codexExecutableReadOnlyRoots(source: NodeJS.ProcessEnv, command = "codex"): string[] {
  const roots = new Set<string>();
  const add = (path: string) => {
    try {
      if (!isAbsolute(path) || resolve(path) === "/" || !existsSync(path)) return;
      roots.add(resolve(path));
      roots.add(realpathSync(path));
    } catch { /* Missing resources remain a normal executable-resolution error. */ }
  };
  add(process.execPath);
  const candidates = isAbsolute(command) ? [command]
    : (source.PATH ?? "").split(delimiter).filter(isAbsolute).map(root => resolve(root, command));
  const executable = candidates.find(path => {
    try { const stat = statSync(path); return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0); } catch { return false; }
  });
  if (!executable) return [...roots];
  add(executable);
  try {
    const canonical = realpathSync(executable);
    const manifestPath = resolve(dirname(canonical), "../package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
    if (manifest.name !== "@openai/codex" || typeof bin !== "string"
      || realpathSync(resolve(dirname(manifestPath), bin)) !== canonical) return [...roots];
    // The npm entrypoint launches the platform package's native executable,
    // which Codex invokes again inside bwrap when starting each shell command.
    const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
    const normalizedPlatformManifest = manifest.optionalDependencies === undefined
      ? normalizedCodexPlatformManifest(manifestPath, platformPackage)
      : undefined;
    if (manifest.optionalDependencies?.[platformPackage] || normalizedPlatformManifest) {
      const platformManifest = normalizedPlatformManifest
        ?? createRequire(manifestPath).resolve(`${platformPackage}/package.json`);
      const packageRoot = realpathSync(dirname(platformManifest));
      const vendor = realpathSync(resolve(packageRoot, "vendor"));
      if (vendor.startsWith(`${packageRoot}/`)) add(vendor);
    } else {
      const packageRoot = realpathSync(dirname(manifestPath));
      const vendor = realpathSync(resolve(packageRoot, "vendor"));
      if (vendor.startsWith(`${packageRoot}/`)) add(vendor);
    }
  } catch { /* Standalone executable installations need no npm resources. */ }
  return [...roots];
}

/** The published server, rather than its bundled JS wrapper, declares npm's host package. */
function normalizedCodexPlatformManifest(runtimeManifest: string, platformPackage: string): string | undefined {
  const profile = QUALIFIED_ACPX_PROFILES.codex;
  const runtime = readCodexPackageManifest(runtimeManifest);
  if (runtime.name !== profile.agentRuntimePackage || runtime.optionalDependencies !== undefined) return undefined;
  for (let root = dirname(dirname(runtimeManifest)), depth = 0; depth < 24; depth += 1) {
    const serverManifest = resolve(root, "package.json");
    if (existsSync(serverManifest)) {
      const server = readCodexPackageManifest(serverManifest);
      if (server.name === "@paperclipai/server") {
        const bridgeDeclaration = server.dependencies?.[profile.agentServerPackage];
        const platformDeclaration = server.optionalDependencies?.[platformPackage];
        const declarationPrefix = `npm:${profile.agentRuntimePackage}@`;
        const declarationSuffix = `-${process.platform}-${process.arch}`;
        if (typeof bridgeDeclaration !== "string" || !bridgeDeclaration.trim()
          || typeof platformDeclaration !== "string" || !platformDeclaration.startsWith(declarationPrefix)
          || !platformDeclaration.endsWith(declarationSuffix)
          || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(platformDeclaration.slice(declarationPrefix.length, -declarationSuffix.length))
          || !codexPathInside(resolve(root, "node_modules"), runtimeManifest)) return undefined;
        const bridgeManifest = createRequire(serverManifest).resolve(`${profile.agentServerPackage}/package.json`);
        if (!codexPathInside(resolve(root, "node_modules"), bridgeManifest)
          || realpathSync(bridgeManifest) !== bridgeManifest) return undefined;
        const bridge = readCodexPackageManifest(bridgeManifest);
        if (bridge.name !== profile.agentServerPackage
          || createRequire(bridgeManifest).resolve(`${profile.agentRuntimePackage}/package.json`) !== runtimeManifest) return undefined;
        const runtimeSelection = createRequire(runtimeManifest).resolve(`${platformPackage}/package.json`);
        const selected = createRequire(serverManifest).resolve(`${platformPackage}/package.json`);
        if (runtimeSelection !== selected || realpathSync(selected) !== selected) return undefined;
        const slot = (createRequire(serverManifest).resolve.paths(platformPackage) ?? []).some(directory => {
          try {
            return (dirname(directory) === root || codexPathInside(dirname(directory), root))
              && realpathSync(directory) === directory
              && selected === resolve(directory, platformPackage, "package.json")
              && realpathSync(dirname(selected)) === dirname(selected);
          } catch { return false; }
        });
        if (!slot) return undefined;
        const native = readCodexPackageManifest(selected);
        if ((native.name !== platformPackage && native.name !== profile.agentRuntimePackage)
          || !Array.isArray(native.os) || !native.os.includes(process.platform)
          || !Array.isArray(native.cpu) || !native.cpu.includes(process.arch)) return undefined;
        return selected;
      }
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return undefined;
}

function codexPathInside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function readCodexPackageManifest(path: string): Record<string, unknown> & {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
} {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 256n * 1024n) throw new Error("Unsafe Codex package manifest");
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Codex package manifest changed during lookup");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex package manifest");
    return value as ReturnType<typeof readCodexPackageManifest>;
  } finally { closeSync(descriptor); }
}

export const CODEX_SKILLLESS_PERMISSION_PROFILE =
  "paperclip-runner-workspace-only";
export const CODEX_PLANNING_PERMISSION_PROFILE =
  "paperclip-runner-workspace-read-only";
export const CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE =
  "paperclip-runner-external-sandbox";

export function codexNetworkAccess(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.PAPERCLIP_RUNNER_NETWORK_ACCESS === "enabled";
}

function gitFilesystemRoots(source: NodeJS.ProcessEnv): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  try {
    const roots: unknown = JSON.parse(source.PAPERCLIP_GIT_METADATA_ROOTS ?? "[]");
    if (Array.isArray(roots)) for (const root of roots) {
      if (typeof root === "string" && isAbsolute(root) && resolve(root) !== "/") write.push(resolve(root));
    }
  } catch { /* Older controllers do not project Git metadata roots. */ }
  if (source.PAPERCLIP_GITHUB_AUTH_MODE === "host" && source.PAPERCLIP_GITHUB_HOST_HOME) {
    for (const relative of [".gitconfig", ".git-credentials", ".config/git", ".config/gh", ".ssh"]) {
      read.push(join(source.PAPERCLIP_GITHUB_HOST_HOME, relative));
    }
    for (const root of [source.GH_CONFIG_DIR, source.GIT_CONFIG_GLOBAL, source.GIT_CONFIG_SYSTEM, source.SSH_AUTH_SOCK]) {
      if (root && isAbsolute(root) && resolve(root) !== "/") read.push(resolve(root));
    }
  }
  return { read: [...new Set(read)], write: [...new Set(write)] };
}

function usesExternalRunnerSandbox(source: NodeJS.ProcessEnv): boolean {
  return source.PAPERCLIP_RUNNER_EXTERNAL_SANDBOX === "1";
}

const SKILLLESS_BASE_CONFIG = {
  "skills.include_instructions": false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: true,
  "features.apps": false,
  "features.plugins": false,
  "features.multi_agent": false,
  "features.memories": false,
  "features.image_generation": false,
} as const;

export function codexCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  if (source.PAPERCLIP_GITHUB_AUTH_MODE === "host" && source.PAPERCLIP_GITHUB_HOST_HOME) {
    environment.HOME = source.PAPERCLIP_GITHUB_HOST_HOME;
  } else if (source.PAPERCLIP_GITHUB_LAUNCHER_DIR) {
    environment.HOME = source.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    environment.ZDOTDIR = source.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    // This is the profile that prepareGitHubOperationLaunchers writes. Every
    // shell the codex process starts reads it, so it must prepend the managed
    // launchers to PATH and must not replace the PATH it inherited.
    environment.BASH_ENV = `${source.PAPERCLIP_GITHUB_LAUNCHER_DIR}/.bashrc`;
  }
  return environment;
}

export function createSkilllessCodexThreadConfig(
  _workingDirectory: string,
  _source: NodeJS.ProcessEnv = process.env,
  includeCollaborationModeInstructions = true,
): Record<string, unknown> {
  return {
    ...SKILLLESS_BASE_CONFIG,
    include_collaboration_mode_instructions:
      includeCollaborationModeInstructions,
  };
}

function collaborationThreadConfig(
  includeCollaborationModeInstructions = true,
  includeSkillInstructions = false,
) {
  return {
    ...SKILLLESS_BASE_CONFIG,
    "skills.include_instructions": includeSkillInstructions,
    include_collaboration_mode_instructions:
      includeCollaborationModeInstructions,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function createIsolatedCodexAppServerArgs(
  source: NodeJS.ProcessEnv | undefined = undefined,
  readOnlyRoots: string[] = [],
  /** Server-registered run copy, never an environment/config-supplied root. */
  instructionWorkingCopyRoot?: string,
): string[] {
  const explicitSource = source;
  source ??= process.env;
  const gitRoots = gitFilesystemRoots(source);
  readOnlyRoots = [...new Set([...readOnlyRoots, ...codexNetworkReadOnlyRoots(source)])];
  const networkAccess = codexNetworkAccess(source);
  const externalRunnerSandbox = usesExternalRunnerSandbox(source);
  const inheritedGitHubKeys = [
    ...githubCredentialEnvironmentKeys(source),
    ...configuredEnvironmentKeys(explicitSource),
    ...["PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY"].filter(key => source[key] !== undefined),
  ];
  const hasProjectedEnvironment = inheritedGitHubKeys.length > 0;
  // Codex filters the configured `set` values through include_only as well.
  // Retain the explicit command PATH/HOME/locale settings, not ambient secrets.
  const commandEnvironment = codexCommandEnvironment(source);
  // Selected task values are inherited, never serialized into configuration argv.
  for (const key of configuredEnvironmentKeys(explicitSource)) delete commandEnvironment[key];
  if (instructionWorkingCopyRoot && source.AGENT_HOME === instructionWorkingCopyRoot) commandEnvironment.AGENT_HOME = instructionWorkingCopyRoot;
  const shellEnvironmentKeys = [...new Set([...inheritedGitHubKeys, ...Object.keys(commandEnvironment)])].sort();
  if (source.PAPERCLIP_GITHUB_LAUNCHER_DIR) readOnlyRoots = [...readOnlyRoots, source.PAPERCLIP_GITHUB_LAUNCHER_DIR];
  const deniedHostRoots = [
    ...new Set(
      [source.HOME, source.CODEX_HOME]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => resolve(value)),
    ),
  ];
  const filesystemRules = [
    `":root"="none"`,
    `":minimal"="read"`,
    `":tmpdir"="none"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}="none"`),
    ...readOnlyRoots.map((path) => `${tomlString(resolve(path))}="read"`),
    ...gitRoots.read.map((path) => `${tomlString(path)}="read"`),
    ...gitRoots.write.map((path) => `${tomlString(path)}="write"`),
    ...(instructionWorkingCopyRoot ? [`${tomlString(resolve(instructionWorkingCopyRoot))}="write"`] : []),
    ...(source.PAPERCLIP_GITHUB_BROKER_TOKEN && source.GH_CONFIG_DIR
      ? [`${tomlString(resolve(source.GH_CONFIG_DIR))}="write"`] : []),
    `":workspace_roots"={"."="write"}`,
  ].join(",");
  const planningFilesystemRules = [
    `":root"="none"`,
    `":minimal"="read"`,
    `":tmpdir"="none"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}="none"`),
    ...readOnlyRoots.map((path) => `${tomlString(resolve(path))}="read"`),
    ...[...gitRoots.read, ...gitRoots.write].map((path) => `${tomlString(path)}="read"`),
    ...(instructionWorkingCopyRoot ? [`${tomlString(resolve(instructionWorkingCopyRoot))}="read"`] : []),
    ...(source.PAPERCLIP_GITHUB_BROKER_TOKEN && source.GH_CONFIG_DIR
      ? [`${tomlString(resolve(source.GH_CONFIG_DIR))}="write"`] : []),
    `":workspace_roots"={"."="read"}`,
  ].join(",");
  const commandEnv = Object.entries(commandEnvironment)
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(",");
  const defaultPermissionProfile = externalRunnerSandbox
    ? CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE
    : CODEX_SKILLLESS_PERMISSION_PROFILE;
  return [
    "-c",
    `default_permissions=${tomlString(defaultPermissionProfile)}`,
    "-c",
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.filesystem={${filesystemRules}}`,
    "-c",
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.network.enabled=${networkAccess}`,
    ...(externalRunnerSandbox
      ? [
          "-c",
          `permissions.${CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE}.filesystem={":root"="write"}`,
          "-c",
          `permissions.${CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE}.network.enabled=${networkAccess}`,
        ]
      : []),
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.filesystem={${planningFilesystemRules}}`,
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.network.enabled=${networkAccess}`,
    "-c",
    `shell_environment_policy.inherit=${tomlString(hasProjectedEnvironment ? "all" : "none")}`,
    "-c",
    `shell_environment_policy.ignore_default_excludes=${hasProjectedEnvironment}`,
    // Codex applies include_only after inheritance. Always emit the bounded
    // allowlist: neither host mode nor a broker enables ambient secret access.
    // Keep values in the process environment, never in argv/config diagnostics.
    "-c",
    `shell_environment_policy.include_only=${JSON.stringify(shellEnvironmentKeys)}`,
    ...(commandEnv.length > 0
      ? ["-c", `shell_environment_policy.set={${commandEnv}}`]
      : []),
    "--disable",
    "image_generation",
    ...(externalRunnerSandbox
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : []),
    "app-server",
  ];
}

export function createSecuredCodexThreadParams(
  workingDirectory: string,
  mode: "default" | "plan" = "default",
  includeCollaborationModeInstructions = true,
  includeSkillInstructions = false,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const permissionProfile =
    mode === "default" && usesExternalRunnerSandbox(source)
      ? CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE
      : mode === "plan"
      ? CODEX_PLANNING_PERMISSION_PROFILE
      : CODEX_SKILLLESS_PERMISSION_PROFILE;
  return {
    cwd: workingDirectory,
    config: collaborationThreadConfig(
      includeCollaborationModeInstructions,
      includeSkillInstructions,
    ),
    permissions: permissionProfile,
    runtimeWorkspaceRoots: [workingDirectory],
  };
}
