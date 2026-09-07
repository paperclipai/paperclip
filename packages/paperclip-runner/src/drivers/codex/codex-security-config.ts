import { resolve } from "node:path";

import {
  githubCredentialEnvironmentKeys,
  hasGitHubCredentialEnvironment,
} from "../../github-credential-environment.js";

export const CODEX_SKILLLESS_PERMISSION_PROFILE =
  "paperclip-runner-workspace-only";
export const CODEX_PLANNING_PERMISSION_PROFILE =
  "paperclip-runner-workspace-read-only";
export const CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE =
  "paperclip-runner-external-sandbox";

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
  const hasGitHubCredential = hasGitHubCredentialEnvironment(source);
  const externalRunnerSandbox = usesExternalRunnerSandbox(source);
  const inheritedGitHubKeys = githubCredentialEnvironmentKeys(source);
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
  const commandEnv = Object.entries(codexCommandEnvironment(source))
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
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.network.enabled=${hasGitHubCredential}`,
    ...(externalRunnerSandbox
      ? [
          "-c",
          `permissions.${CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE}.filesystem={":root"="write"}`,
          "-c",
          `permissions.${CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE}.network.enabled=true`,
        ]
      : []),
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.filesystem={${planningFilesystemRules}}`,
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.network.enabled=${hasGitHubCredential}`,
    "-c",
    `shell_environment_policy.inherit=${tomlString(hasGitHubCredential ? "all" : "none")}`,
    "-c",
    `shell_environment_policy.ignore_default_excludes=${hasGitHubCredential}`,
    ...(hasGitHubCredential
      ? [
          "-c",
          `shell_environment_policy.include_only=${JSON.stringify(inheritedGitHubKeys)}`,
        ]
      : []),
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
