export interface GitAuthCommandEvent {
  eventType: string;
  payload?: Record<string, unknown> | null;
}

export interface GitHubWorkspaceFailureRun {
  resultJson?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
}

interface CommandExecutionRecord {
  command: string;
  output: string;
}

const GITHUB_HOST_URL_RE =
  /(?:^|[\s'"`(\[])(?:(?:https?|ssh|git):\/\/(?:[^/\s'"`@]+@)?|git@)github\.com(?::\d+)?(?:[/:]|$|[\s'"`)\]])/i;

const GH_CLI_UNAUTHENTICATED_PATTERNS = [
  /\byou are not logged into any github hosts\b/i,
  /\bto get started with github cli,\s*please run:\s*gh auth login\b/i,
  /\bto authenticate,\s*please run\s+[`'"]?gh auth login[`'"]?/i,
  /\bauthentication token not found for host\s+github\.com\b/i,
  /\bfailed to log in to github\.com\b/i,
];

const GIT_GITHUB_AUTH_FAILURE_PATTERNS = [
  /fatal:\s*could not read (?:username|password) for ['"]https?:\/\/(?:[^'"/\s@]+@)?github\.com(?:[/:][^'"]*)?['"]/i,
  /fatal:\s*authentication failed for ['"]https?:\/\/(?:[^'"/\s@]+@)?github\.com(?:[/:][^'"]*)?['"]/i,
  /fatal:\s*unable to access ['"]https?:\/\/(?:[^'"/\s@]+@)?github\.com(?:[/:][^'"]*)?['"]:\s*the requested url returned error:\s*(?:401|403|404)\b/i,
  /fatal:\s*repository ['"]https?:\/\/(?:[^'"/\s@]+@)?github\.com(?:[/:][^'"]*)?['"] not found\b/i,
  /\bgit@github\.com:\s*permission denied\s*\((?:publickey|password|keyboard-interactive)/i,
  /https?:\/\/(?:[^'"/\s@]+@)?github\.com\b[^\n]*\bterminal prompts disabled\b/i,
];

const GIT_REMOTE_AUTH_FAILURE_RE =
  /remote:\s*(?:repository not found|permission to [^\n]+ denied|invalid username or (?:password|token)|support for password authentication was removed|write access to repository not granted)/i;

const WORKSPACE_CLONE_AUTH_REASONS = new Set(["authentication_failed", "repository_unavailable"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function joinTextParts(parts: unknown[]): string {
  return parts
    .map(asNonEmptyString)
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

export function isGitHubRemoteUrl(value: unknown): boolean {
  const text = asNonEmptyString(value);
  return text !== null && GITHUB_HOST_URL_RE.test(text);
}

function extractFailedCommandExecution(event: GitAuthCommandEvent): CommandExecutionRecord | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const prpEvent = asRecord(payload.prpEvent);
  const prpPayload = asRecord(prpEvent?.payload);

  if (event.eventType === "tool.execution.completed") {
    const body = prpPayload ?? payload;
    const exitCode = typeof body.exitCode === "number" ? body.exitCode : null;
    const status = asNonEmptyString(body.status)?.toLowerCase() ?? null;
    const failed = exitCode !== null
      ? exitCode !== 0
      : (status === "failed" || status === "error");
    if (!failed) return null;
    const output = joinTextParts([body.output, body.stderr, body.error]);
    if (!output) return null;
    const command = joinTextParts([body.command, body.name, body.subject]);
    return { command, output };
  }

  if (event.eventType === "item.completed") {
    const item = asRecord(prpPayload?.item) ?? asRecord(payload.item);
    if (!item) return null;
    const itemType = asNonEmptyString(item.type);
    if (itemType !== "command_execution" && itemType !== "commandExecution") return null;
    const exitCode = typeof item.exit_code === "number"
      ? item.exit_code
      : typeof item.exitCode === "number"
        ? item.exitCode
        : null;
    const status = asNonEmptyString(item.status)?.toLowerCase() ?? null;
    const failed = exitCode !== null
      ? exitCode !== 0
      : (status === "failed" || status === "error");
    if (!failed) return null;
    const output = joinTextParts([item.aggregated_output, item.aggregatedOutput, item.output, item.stderr]);
    if (!output) return null;
    const command = asNonEmptyString(item.command) ?? "";
    return { command, output };
  }

  return null;
}

function matchesUnconfiguredGitHubAuthFailure(execution: CommandExecutionRecord): boolean {
  const { output } = execution;
  if (GH_CLI_UNAUTHENTICATED_PATTERNS.some((pattern) => pattern.test(output))) {
    return true;
  }
  if (GIT_GITHUB_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) {
    return true;
  }
  if (GIT_REMOTE_AUTH_FAILURE_RE.test(output) && isGitHubRemoteUrl(output)) {
    return true;
  }
  return false;
}

export function detectUnconfiguredGitHubAuthFailureInEvents(
  events: Iterable<GitAuthCommandEvent>,
): boolean {
  for (const event of events) {
    const execution = extractFailedCommandExecution(event);
    if (execution && matchesUnconfiguredGitHubAuthFailure(execution)) {
      return true;
    }
  }
  return false;
}

function isGitCloneAuthFailureObject(value: unknown): boolean {
  const failure = asRecord(value);
  if (!failure) return false;
  return failure.provider === "git"
    && failure.operation === "clone"
    && typeof failure.reason === "string"
    && WORKSPACE_CLONE_AUTH_REASONS.has(failure.reason);
}

export function isGitHubWorkspaceCloneAuthFailure(run: GitHubWorkspaceFailureRun): boolean {
  const resultJson = asRecord(run.resultJson);
  if (!resultJson) return false;
  const contextSnapshot = asRecord(run.contextSnapshot);

  if (isGitCloneAuthFailureObject(resultJson.connectionFailure)) {
    const failure = asRecord(resultJson.connectionFailure);
    const repoCandidates = [
      contextSnapshot?.workspaceRepoUrl,
      contextSnapshot?.repoUrl,
      resultJson.repoUrl,
      failure?.repoUrl,
    ];
    if (repoCandidates.some(isGitHubRemoteUrl)) return true;
  }

  const validation = asRecord(resultJson.workspaceValidation);
  const materializationFailures = Array.isArray(validation?.materializationFailures)
    ? validation.materializationFailures
    : [];
  for (const entry of materializationFailures) {
    const record = asRecord(entry);
    if (!record) continue;
    if (isGitCloneAuthFailureObject(record.connectionFailure) && isGitHubRemoteUrl(record.repoUrl)) {
      return true;
    }
  }

  return false;
}
