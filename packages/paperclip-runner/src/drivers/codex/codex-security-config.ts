import { resolve } from "node:path";

const SKILLLESS_PERMISSION_PROFILE = "paperclip-runner-workspace-only";
const PLANNING_PERMISSION_PROFILE = "paperclip-runner-workspace-read-only";

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

function commandEnvironment(
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
  source: NodeJS.ProcessEnv = process.env,
  readOnlyRoots: string[] = [],
): string[] {
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
    `":workspace_roots"={"."="write"}`,
  ].join(",");
  const planningFilesystemRules = [
    `":root"="none"`,
    `":minimal"="read"`,
    `":tmpdir"="none"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}="none"`),
    ...readOnlyRoots.map((path) => `${tomlString(resolve(path))}="read"`),
    `":workspace_roots"={"."="read"}`,
  ].join(",");
  const commandEnv = Object.entries(commandEnvironment(source))
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(",");
  return [
    "-c",
    `default_permissions=${tomlString(SKILLLESS_PERMISSION_PROFILE)}`,
    "-c",
    `permissions.${SKILLLESS_PERMISSION_PROFILE}.filesystem={${filesystemRules}}`,
    "-c",
    `permissions.${SKILLLESS_PERMISSION_PROFILE}.network.enabled=false`,
    "-c",
    `permissions.${PLANNING_PERMISSION_PROFILE}.filesystem={${planningFilesystemRules}}`,
    "-c",
    `permissions.${PLANNING_PERMISSION_PROFILE}.network.enabled=false`,
    "-c",
    `shell_environment_policy.inherit="none"`,
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    ...(commandEnv.length > 0
      ? ["-c", `shell_environment_policy.set={${commandEnv}}`]
      : []),
    "--disable",
    "image_generation",
    "app-server",
  ];
}

export function createSecuredCodexThreadParams(
  workingDirectory: string,
  mode: "default" | "plan" = "default",
  includeCollaborationModeInstructions = true,
  includeSkillInstructions = false,
): Record<string, unknown> {
  const permissionProfile =
    mode === "plan"
      ? PLANNING_PERMISSION_PROFILE
      : SKILLLESS_PERMISSION_PROFILE;
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
