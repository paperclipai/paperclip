import { resolve } from "node:path";

export const CODEX_SKILLLESS_PERMISSION_PROFILE = "paperclip-runner-workspace-only";
export const CODEX_PLANNING_PERMISSION_PROFILE = "paperclip-runner-workspace-read-only";

/**
 * Fixed, server-owned structured result for the Formal-QA lane. Dynamic
 * binding fields remain strings here; the Formal-QA service independently
 * verifies them against its sealed review/run/checkout authority before it
 * writes any terminal decision.
 */
export const FORMAL_QA_FINDING_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "body", "path", "line"],
  properties: {
    severity: { enum: ["info", "low", "medium", "high", "critical"] },
    title: { type: "string", minLength: 1, maxLength: 500 },
    body: { type: "string", minLength: 1, maxLength: 10_000 },
    path: { type: "string", minLength: 1, maxLength: 1024 },
    line: { type: "integer", minimum: 1, maximum: 10_000_000 },
  },
} as const;

export const FORMAL_QA_DECISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "reviewId",
    "runId",
    "headSha",
    "treeSha",
    "contractSha256",
    "decision",
    "summary",
    "findings",
  ],
  properties: {
    schema: { type: "string", const: "paperclip.formal-qa-review-decision/v1" },
    reviewId: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    headSha: { type: "string", minLength: 1 },
    treeSha: { type: "string", minLength: 1 },
    contractSha256: { type: "string", minLength: 1 },
    decision: { enum: ["approved", "rejected"] },
    summary: { type: "string", maxLength: 10_000 },
    findings: { type: "array", maxItems: 100, items: FORMAL_QA_FINDING_OUTPUT_SCHEMA },
  },
} as const;

/** The Formal-QA source surface is closed: no checkout mount or caller tools. */
export const FORMAL_QA_CONTENT_TOOL_SPECS = [
  {
    name: "formal_qa_list_files",
    description: "List sealed review files beneath an optional repository-relative prefix.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { prefix: { type: "string", maxLength: 512 } },
    },
  },
  {
    name: "formal_qa_read_file",
    description: "Read one sealed repository-relative regular file.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
    },
  },
  {
    name: "formal_qa_search",
    description: "Search sealed review text files for a literal query.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: { query: { type: "string", minLength: 1, maxLength: 256 } },
    },
  },
] as const;

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
  additionalDeniedRoots: readonly string[] = [],
): string[] {
  const normalizedReadOnlyRoots = normalizeReadOnlyRoots(readOnlyRoots);
  const deniedHostRoots = [
    ...new Set(
      [source.HOME, source.CODEX_HOME, ...additionalDeniedRoots]
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
    ...normalizedReadOnlyRoots.map((path) => `${tomlString(path)}="read"`),
    `":workspace_roots"={"."="write"}`,
  ].join(",");
  const planningFilesystemRules = [
    `":root"="none"`,
    `":minimal"="read"`,
    `":tmpdir"="none"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}="none"`),
    ...normalizedReadOnlyRoots.map((path) => `${tomlString(path)}="read"`),
    `":workspace_roots"={"."="read"}`,
  ].join(",");
  const commandEnv = Object.entries(codexCommandEnvironment(source))
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(",");
  return [
    "-c",
    `default_permissions=${tomlString(CODEX_SKILLLESS_PERMISSION_PROFILE)}`,
    "-c",
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.filesystem={${filesystemRules}}`,
    "-c",
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.network.enabled=false`,
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.filesystem={${planningFilesystemRules}}`,
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.network.enabled=false`,
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

function normalizeReadOnlyRoots(readOnlyRoots: readonly string[]): string[] {
  const normalized = [...new Set(readOnlyRoots.map((candidate) => resolve(candidate)))];
  for (const root of normalized) {
    if (root === "/") {
      throw new Error("Codex read-only root cannot be the filesystem root");
    }
  }
  return normalized;
}

export function createSecuredCodexThreadParams(
  workingDirectory: string,
  mode: "default" | "plan" = "default",
  includeCollaborationModeInstructions = true,
  includeSkillInstructions = false,
): Record<string, unknown> {
  const permissionProfile =
    mode === "plan"
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
