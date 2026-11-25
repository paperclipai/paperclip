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
  failed: boolean;
}

type ParsedGitHubCommand =
  | { kind: "git"; subcommand: string | null }
  | { kind: "gh"; authenticated: boolean };

const GITHUB_HOST_URL_RE =
  /(?:^|[\s'"`(\[])(?:(?:https?|ssh|git):\/\/(?:[^/\s'"`@]+@)?|git@)github\.com(?::\d+)?(?:[/:]|$|[\s'"`)\]])/i;

const GITHUB_REPO_RE =
  /(?:(?:https?|ssh|git):\/\/(?:[^/\s'"`@]+@)?|git@)github\.com(?::\d+)?[/:]([a-z0-9._-]+\/[a-z0-9._-]+?)(?:\.git)?(?=$|[/\s'"`)\],;])/i;

const GENERIC_SHELL_TOOL_NAMES = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "exec",
  "terminal",
  "command",
  "run_command",
  "execute_command",
  "shell_command",
  "process",
]);

const GIT_VALUE_GLOBAL_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

const GIT_REMOTE_READ_SUBCOMMANDS = new Set(["clone", "fetch", "pull", "ls-remote"]);

const GH_LOCAL_SUBCOMMANDS = new Set(["help", "version", "completion"]);

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

const NON_GITHUB_REMOTE_URL_RE =
  /(?:(?:https?|ssh|git):\/\/(?:[^/\s'"`@]+@)?|git@)(?!github\.com(?::\d+)?(?:[/:]|$))[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?[/:]/i;

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

function resolveToolCommand(body: Record<string, unknown>): string {
  const explicitCommand = joinTextParts([body.command, body.subject]);
  if (explicitCommand) return explicitCommand;
  const name = asNonEmptyString(body.name);
  if (!name) return "";
  // Generic shell tool names (for example OpenCode's `name: "bash"`) do not
  // carry the executed command text; treat them as omitted command metadata.
  if (GENERIC_SHELL_TOOL_NAMES.has(name.toLowerCase())) return "";
  return name;
}

export function isGitHubRemoteUrl(value: unknown): boolean {
  const text = asNonEmptyString(value);
  return text !== null && GITHUB_HOST_URL_RE.test(text);
}

function extractGitHubRepoSlug(text: string): string | null {
  const match = text.match(GITHUB_REPO_RE);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  const tokenRe = /'([^']*)'|"([^"]*)"|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(segment)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function unwrapShellWrapper(command: string): string {
  const trimmed = command.trim();
  const wrapper = trimmed.match(/^(?:(?:\/[\w./-]+\/)?(?:bash|sh|zsh))\s+(?:-[a-zA-Z]*c)\s+(['"])([\s\S]*)\1$/);
  return wrapper?.[2] ? wrapper[2] : trimmed;
}

function basename(executable: string): string {
  const idx = Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\"));
  return (idx >= 0 ? executable.slice(idx + 1) : executable).toLowerCase();
}

function parseCommandSegment(segment: string): ParsedGitHubCommand[] {
  const tokens = tokenizeSegment(segment);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1;
      continue;
    }
    const base = basename(token);
    if (base === "env") {
      i += 1;
      while (i < tokens.length) {
        const arg = tokens[i]!;
        if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
          i += 2;
        } else if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          i += 1;
        } else {
          break;
        }
      }
      continue;
    }
    if (base === "timeout") {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const arg = tokens[i]!;
        if (arg === "-k" || arg === "--kill-after" || arg === "-s" || arg === "--signal") {
          i += 2;
        } else {
          i += 1;
        }
      }
      // Skip the duration argument (e.g. "60", "30s", "2m").
      if (i < tokens.length) i += 1;
      continue;
    }
    if (base === "nice") {
      i += 1;
      if (tokens[i] === "-n" || tokens[i] === "--adjustment") {
        i += 2;
      } else if (tokens[i]?.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (base === "stdbuf") {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const arg = tokens[i]!;
        if (arg === "-i" || arg === "-o" || arg === "-e" || arg === "--input" || arg === "--output" || arg === "--error") {
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (base === "sudo") {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const arg = tokens[i]!;
        if (arg === "--") {
          i += 1;
          break;
        }
        if (arg === "-u" || arg === "-g" || arg === "-C" || arg === "-h" || arg === "-p" || arg === "-r" || arg === "-t") {
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (base === "nohup" || base === "time" || base === "command" || base === "exec" || base === "setsid" || base === "unbuffer") {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (base === "bash" || base === "sh" || base === "zsh") {
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.startsWith("-")) {
        const flag = tokens[j]!;
        j += 1;
        if (/^-[a-zA-Z]*c$/.test(flag) && j < tokens.length) {
          return parseGitHubCommands(tokens[j]!);
        }
      }
      return [];
    }
    if (base === "git") {
      i += 1;
      while (i < tokens.length) {
        const arg = tokens[i]!;
        if (GIT_VALUE_GLOBAL_FLAGS.has(arg)) {
          i += 2;
          continue;
        }
        if (arg.startsWith("-")) {
          i += 1;
          continue;
        }
        return [{ kind: "git", subcommand: arg.toLowerCase() }];
      }
      return [{ kind: "git", subcommand: null }];
    }
    if (base === "gh") {
      const rest = tokens.slice(i + 1);
      const hasHelpOrVersionFlag = rest.some((arg) => arg === "-h" || arg === "--help" || arg === "--version");
      const firstSubcommand = rest.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? null;
      const isLocal = hasHelpOrVersionFlag || !firstSubcommand || GH_LOCAL_SUBCOMMANDS.has(firstSubcommand);
      return [{ kind: "gh", authenticated: !isLocal }];
    }
    return [];
  }
  return [];
}

function parseGitHubCommands(command: string): ParsedGitHubCommand[] {
  if (!command.trim()) return [];
  const unwrapped = unwrapShellWrapper(command);
  const segments = splitShellSegments(unwrapped);
  const parsed: ParsedGitHubCommand[] = [];
  for (const segment of segments) {
    parsed.push(...parseCommandSegment(segment));
  }
  return parsed;
}

function extractCommandExecution(event: GitAuthCommandEvent): CommandExecutionRecord | null {
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
    const output = joinTextParts([body.output, body.stderr, body.error]);
    const command = resolveToolCommand(body);
    if (!output && !command) return null;
    return { command, output, failed };
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
    const output = joinTextParts([item.aggregated_output, item.aggregatedOutput, item.output, item.stderr]);
    const command = asNonEmptyString(item.command) ?? "";
    if (!output && !command) return null;
    return { command, output, failed };
  }

  return null;
}

function matchesUnconfiguredGitHubAuthFailure(execution: CommandExecutionRecord): boolean {
  if (!execution.failed || !execution.output) return false;
  if (execution.command.length > 0 && parseGitHubCommands(execution.command).length === 0) {
    return false;
  }
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

function didRecoverGitHubAuth(
  execution: CommandExecutionRecord,
  failedRepoSlug: string | null,
): boolean {
  if (execution.failed || execution.command.length === 0) return false;
  const commands = parseGitHubCommands(execution.command);
  if (commands.length === 0) return false;
  const combined = `${execution.command}\n${execution.output}`;
  if (NON_GITHUB_REMOTE_URL_RE.test(combined) && !isGitHubRemoteUrl(combined)) {
    return false;
  }
  const hasGitHubRemote = isGitHubRemoteUrl(combined);
  const succeededRepoSlug = extractGitHubRepoSlug(combined);
  for (const cmd of commands) {
    if (cmd.kind === "gh" && cmd.authenticated) {
      if (!failedRepoSlug || !succeededRepoSlug || succeededRepoSlug === failedRepoSlug) {
        return true;
      }
    }
    if (cmd.kind === "git" && cmd.subcommand === "push") {
      // A successful `git push` already proved remote write auth; quiet or
      // "Everything up-to-date" output may omit the remote URL, while non-GitHub
      // remote URLs are already excluded above.
      if (!failedRepoSlug || !succeededRepoSlug || succeededRepoSlug === failedRepoSlug) {
        return true;
      }
    }
    if (cmd.kind === "git" && cmd.subcommand && GIT_REMOTE_READ_SUBCOMMANDS.has(cmd.subcommand) && hasGitHubRemote) {
      // A successful public clone/fetch of a different repository does not prove
      // access to the private GitHub repository that previously failed.
      if (failedRepoSlug && succeededRepoSlug === failedRepoSlug) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Inspects command events in chronological order (oldest -> newest) and returns
 * true only when an unconfigured GitHub auth failure occurred and was not
 * followed by a matching successful authenticated GitHub command.
 */
export function detectUnconfiguredGitHubAuthFailureInEvents(
  events: Iterable<GitAuthCommandEvent>,
): boolean {
  let detected = false;
  let failedRepoSlug: string | null = null;
  for (const event of events) {
    const execution = extractCommandExecution(event);
    if (!execution) continue;
    if (matchesUnconfiguredGitHubAuthFailure(execution)) {
      detected = true;
      failedRepoSlug = extractGitHubRepoSlug(`${execution.command}\n${execution.output}`);
    } else if (detected && didRecoverGitHubAuth(execution, failedRepoSlug)) {
      detected = false;
      failedRepoSlug = null;
    }
  }
  return detected;
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
