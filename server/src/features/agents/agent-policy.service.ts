import path from "node:path";
import type { AgentProvider } from "./agent-provider.types.js";
import type { AgentStatus } from "./agent-status.types.js";
import type { OrganizationAgentConfig } from "./organization-agent-config.types.js";
import type { PaperclipTask } from "./paperclip-task.types.js";
import { normalizePaperclipTaskType } from "./paperclip-task.types.js";
import { AgentRoutingService } from "./agent-routing.service.js";
import { isDevelopmentEnvironment } from "../development-environment.js";

export const DEFAULT_CODEX_ALLOWED_COMMANDS = [
  "git status",
  "git diff",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
  "find",
  "grep",
  "cat",
  "sed",
] as const;

export const DEFAULT_CODEX_FORBIDDEN_PATHS = [
  ".env",
  ".env.*",
  ".secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/credentials/**",
  "**/secrets/**",
] as const;

export const DEFAULT_CODEX_FORBIDDEN_COMMANDS = [
  "sudo",
  "su",
  "rm -rf",
  "chmod 777",
  "chown -R",
  "git push",
  "git reset --hard",
  "git clean -fd",
  "docker system prune",
  "curl unknown domains",
  "wget unknown domains",
  "ssh production servers",
  "commands that read secrets",
] as const;

export interface AgentPolicyInput {
  task: PaperclipTask;
  agent: AgentProvider;
  organizationConfig?: OrganizationAgentConfig | null;
  allowedPaths?: string[];
  allowedCommands?: string[];
  forbiddenPaths?: string[];
  forbiddenCommands?: string[];
  requestedCommands?: string[];
  reason?: string;
  claudeStatus?: AgentStatus;
  codexStatus?: AgentStatus;
  repoRoot?: string;
}

export interface AgentPolicyResult {
  allowed: boolean;
  reason?: string;
  validationResults: string[];
}

const SECURITY_SENSITIVE_RE =
  /\b(auth|authentication|authorization|rbac|secrets?|credentials?|token|key|pem|production|deploy(?:ment)?|infrastructure|terraform|kubernetes|docker\s+compose|database\s+schema|migration)\b/i;

const REPO_WIDE_RE =
  /\b(entire|whole|all|unrestricted|repo(?:sitory)?-wide|repository wide|any file|all files|everything)\b/i;

function normalizePathForPolicy(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePathForPolicy(glob);
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out);
}

export function pathMatchesPolicy(candidate: string, policy: string): boolean {
  const normalizedCandidate = normalizePathForPolicy(candidate);
  const normalizedPolicy = normalizePathForPolicy(policy);
  if (normalizedCandidate === normalizedPolicy) return true;
  if (globToRegExp(normalizedPolicy).test(normalizedCandidate)) return true;
  if (path.isAbsolute(normalizedPolicy)) return globToRegExp(normalizedPolicy).test(normalizedCandidate);
  return globToRegExp(`**/${normalizedPolicy}`).test(normalizedCandidate);
}

function isUnrestrictedPath(candidate: string, repoRoot: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === "." || trimmed === "./" || trimmed === "/" || trimmed === "*" || trimmed === "**") {
    return true;
  }
  if (path.resolve(repoRoot, trimmed) === path.resolve(repoRoot)) return true;
  return false;
}

function commandBase(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function commandAllowed(command: string, allowedCommands: readonly string[]): boolean {
  const normalized = commandBase(command);
  return allowedCommands.some((allowed) => {
    const allowedNormalized = commandBase(allowed);
    return normalized === allowedNormalized || normalized.startsWith(`${allowedNormalized} `);
  });
}

function commandForbidden(command: string, forbiddenCommands: readonly string[]): boolean {
  const normalized = commandBase(command).toLowerCase();
  return forbiddenCommands.some((forbidden) => {
    const forbiddenNormalized = commandBase(forbidden).toLowerCase();
    return normalized === forbiddenNormalized || normalized.includes(forbiddenNormalized);
  });
}

function compactList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export class AgentPolicyService {
  private readonly routing = new AgentRoutingService();

  validateExecution(input: AgentPolicyInput): AgentPolicyResult {
    if (input.agent !== "codex") return { allowed: true, validationResults: ["Claude execution allowed"] };
    const errors = this.validateCodexExecution(input);
    if (errors.length > 0) {
      return {
        allowed: false,
        reason: `Codex execution rejected: ${errors.join("; ")}`,
        validationResults: errors,
      };
    }
    return { allowed: true, validationResults: ["Codex restricted policy validation passed"] };
  }

  private validateCodexExecution(input: AgentPolicyInput): string[] {
    const task = input.task;
    const taskType = normalizePaperclipTaskType(task.type);
    const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
    const allowedPaths = compactList(input.allowedPaths ?? task.allowedPaths);
    const configuredAllowedCommands = compactList(input.allowedCommands ?? task.allowedCommands);
    const configuredForbiddenPaths = compactList(input.forbiddenPaths ?? task.forbiddenPaths);
    const configuredForbiddenCommands = compactList(input.forbiddenCommands ?? task.forbiddenCommands);
    const allowedCommands = configuredAllowedCommands.length > 0
      ? configuredAllowedCommands
      : [...DEFAULT_CODEX_ALLOWED_COMMANDS];
    const forbiddenPaths = configuredForbiddenPaths.length > 0
      ? configuredForbiddenPaths
      : [...DEFAULT_CODEX_FORBIDDEN_PATHS];
    const forbiddenCommands = configuredForbiddenCommands.length > 0
      ? configuredForbiddenCommands
      : [...DEFAULT_CODEX_FORBIDDEN_COMMANDS];
    const requestedCommands = compactList(input.requestedCommands ?? task.requestedCommands);
    const reason = (input.reason ?? task.reason ?? "").trim();
    const scope = (task.approvedScope ?? "").trim();
    const goal = (task.originalGoal ?? "").trim();
    const claudeStatus = input.claudeStatus ?? "unknown";
    const fallbackAllowed = this.routing.isFallbackStatus(claudeStatus);
    const errors: string[] = [];

    if (!isDevelopmentEnvironment()) {
      errors.push("Codex execution is only available in development mode");
    }
    if (!task.id) errors.push("task has no ID");
    if (!taskType) errors.push("task has no type");
    if (!scope) errors.push("task has no explicit scope");
    if (allowedPaths.length === 0) errors.push("task has no explicit allowed paths");
    if (!reason) errors.push("task has no Codex activation reason");
    if (!input.organizationConfig?.dualMode && !fallbackAllowed) {
      errors.push("Codex execution requires dual-mode routing or an unavailable primary agent");
    }
    if (input.organizationConfig?.dualMode && !fallbackAllowed) {
      const config = input.organizationConfig;
      if (config.primaryAgent === "claude" && config.secondaryAgent === "codex" && claudeStatus === "available") {
        errors.push("Primary agent is available; Codex secondary execution is not needed");
      }
    }
    if (claudeStatus === "tokens_low") {
      errors.push("Claude tokens_low must stay on Claude and request a compact handoff");
    }
    if (taskType === "architecture") errors.push("Codex cannot run architecture tasks");
    if (task.requiresProductionDeployment === true) errors.push("Codex cannot run production deployment tasks");
    if (task.securitySensitive === true && task.explicitApproval !== true) {
      errors.push("security-sensitive task requires explicit Claude/human approval");
    }
    if (SECURITY_SENSITIVE_RE.test(`${goal}\n${scope}`)) {
      errors.push("security-sensitive, infrastructure, deployment, secrets, auth, or schema work requires Claude/human approval");
    }
    if (REPO_WIDE_RE.test(`${goal}\n${scope}`)) errors.push("unrestricted repository-wide scope is not allowed");

    for (const allowedPath of allowedPaths) {
      if (isUnrestrictedPath(allowedPath, repoRoot)) errors.push(`allowed path is unrestricted: ${allowedPath}`);
      for (const forbiddenPath of forbiddenPaths) {
        if (pathMatchesPolicy(allowedPath, forbiddenPath)) {
          errors.push(`allowed path intersects forbidden path policy: ${allowedPath}`);
        }
      }
    }

    for (const contextFile of compactList(task.contextFiles)) {
      for (const forbiddenPath of forbiddenPaths) {
        if (pathMatchesPolicy(contextFile, forbiddenPath)) errors.push(`context file is forbidden: ${contextFile}`);
      }
    }

    for (const command of allowedCommands) {
      if (commandForbidden(command, forbiddenCommands)) errors.push(`allowed command is forbidden by policy: ${command}`);
    }
    for (const command of requestedCommands) {
      if (!commandAllowed(command, allowedCommands)) errors.push(`requested command is not allowed: ${command}`);
      if (commandForbidden(command, forbiddenCommands)) errors.push(`requested command is forbidden: ${command}`);
    }

    return errors;
  }
}

export const agentPolicyService = new AgentPolicyService();
