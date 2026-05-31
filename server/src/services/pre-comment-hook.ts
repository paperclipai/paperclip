import { spawn } from "node:child_process";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export type PreCommentHookAction = "block" | "warn" | "escalate" | "exec";

export type ExecOnExitVerdict = "pass+append_audit" | "block" | "block+escalate" | "warn";

export type ResolvedAction = "block" | "warn" | "escalate" | "pass";

export interface PreCommentHookTrigger {
  agentId?: string;
  statusTransition?: string;
  bodyMatches?: string;
}

export interface PreCommentHookConfig {
  trigger?: PreCommentHookTrigger;
  action?: PreCommentHookAction;
  message?: string;
  /** When action === "exec": absolute path command and args. */
  command?: string[];
  /** What to feed via stdin. Currently supported: "comment.body" or omit. */
  stdin?: "comment.body";
  /**
   * Mapping of stringified exit codes to verdicts. Special key "default" applies
   * when an exit code has no explicit mapping. Verdicts:
   *   - "pass+append_audit": comment passes through; exec stdout appended to audit block
   *   - "warn": non-blocking; logged as warn
   *   - "block": comment blocked
   *   - "block+escalate": blocked and additionally escalated (separate activity log entry)
   * Default mapping when omitted entirely: { "0": "pass+append_audit", "default": "block" }.
   */
  onExit?: Record<string, ExecOnExitVerdict>;
  /** Hard timeout for the exec process. Default 30000. Hard upper bound 60000. */
  timeoutMs?: number;
}

export interface PreCommentHookContext {
  companyId: string;
  issueId: string;
  agentId: string | null;
  body: string;
  source: "comment" | "update";
  statusTransition: string | null;
}

export interface ExecOutcome {
  /** "exit" if process terminated normally with a code, "timeout" if killed by us, "spawn_error" if spawn failed, "denied" if command not on allowlist. */
  status: "exit" | "timeout" | "spawn_error" | "denied";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** ms the child took to terminate (timeout counter included). */
  durationMs: number;
  verdict: ExecOnExitVerdict;
  /** "exit", "default", "timeout", "spawn_error", "denied" or "no_action" — which onExit-key produced verdict. */
  verdictSource: string;
}

export interface PreCommentHookMatch {
  hookIndex: number;
  action: PreCommentHookAction;
  /** Resolved action after exec evaluation (for non-exec hooks this equals `action`). "pass" only possible for exec. */
  resolvedAction: ResolvedAction;
  message: string | null;
  matchedBy: {
    agentId: boolean;
    statusTransition: boolean;
    bodyMatches: boolean;
  };
  trigger: PreCommentHookTrigger;
  /** Only populated for exec actions. */
  exec?: ExecOutcome;
}

export interface PreCommentHookEvaluation {
  blocked: boolean;
  matches: PreCommentHookMatch[];
}

const VALID_ACTIONS: ReadonlySet<PreCommentHookAction> = new Set([
  "block",
  "warn",
  "escalate",
  "exec",
]);

const VALID_EXEC_VERDICTS: ReadonlySet<ExecOnExitVerdict> = new Set([
  "pass+append_audit",
  "warn",
  "block",
  "block+escalate",
]);

/** Hard ceiling regardless of config. */
const EXEC_TIMEOUT_HARD_MAX_MS = 60_000;
/** Default timeout when omitted. */
const EXEC_TIMEOUT_DEFAULT_MS = 30_000;
/** Capture stdout/stderr up to this many bytes; remainder is silently dropped. */
const EXEC_STREAM_CAPTURE_MAX_BYTES = 16_384;

const DEFAULT_ON_EXIT: Readonly<Record<string, ExecOnExitVerdict>> = Object.freeze({
  "0": "pass+append_audit",
  default: "block",
});

/**
 * Server-side command allowlist for `action: exec`. Comma- or colon-separated
 * absolute paths read from `PAPERCLIP_PRE_COMMENT_HOOK_EXEC_ALLOWLIST`. The
 * resolved (path.resolve) `command[0]` MUST equal one of the allowlist entries
 * exactly, or the hook is denied. Empty allowlist (or env-var missing) means
 * `action: exec` is universally denied — fail-closed by default. Operators
 * must opt-in per-deployment by listing the exact binary paths permitted.
 */
function readExecAllowlist(): ReadonlySet<string> {
  const raw = process.env.PAPERCLIP_PRE_COMMENT_HOOK_EXEC_ALLOWLIST ?? "";
  const entries = raw
    .split(/[,:]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && path.isAbsolute(s))
    .map((s) => path.resolve(s));
  return new Set(entries);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCommand(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (parts.length === 0) return undefined;
  return parts;
}

function parseOnExit(raw: unknown): Record<string, ExecOnExitVerdict> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, ExecOnExitVerdict> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string") continue;
    if (!(VALID_EXEC_VERDICTS as Set<string>).has(value)) continue;
    out[key] = value as ExecOnExitVerdict;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseTimeout(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.floor(raw), EXEC_TIMEOUT_HARD_MAX_MS);
}

export function parsePreCommentHooks(adapterConfig: unknown): PreCommentHookConfig[] {
  if (!isPlainObject(adapterConfig)) return [];
  const raw = adapterConfig.preCommentHooks;
  return asArray(raw).map((entry): PreCommentHookConfig => {
    if (!isPlainObject(entry)) return {};
    const triggerRaw = isPlainObject(entry.trigger) ? entry.trigger : {};
    const trigger: PreCommentHookTrigger = {
      agentId: asString(triggerRaw.agentId),
      statusTransition: asString(triggerRaw.statusTransition),
      bodyMatches: asString(triggerRaw.bodyMatches),
    };
    const actionRaw = asString(entry.action);
    const action: PreCommentHookAction | undefined =
      actionRaw && (VALID_ACTIONS as Set<string>).has(actionRaw)
        ? (actionRaw as PreCommentHookAction)
        : undefined;
    const message = asString(entry.message) ?? null;
    const cfg: PreCommentHookConfig = { trigger, action, message: message ?? undefined };
    if (action === "exec") {
      cfg.command = parseCommand(entry.command);
      const stdinRaw = asString(entry.stdin);
      if (stdinRaw === "comment.body") cfg.stdin = "comment.body";
      cfg.onExit = parseOnExit(entry.onExit);
      cfg.timeoutMs = parseTimeout(entry.timeoutMs);
    }
    return cfg;
  });
}

function compileBodyRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch (err) {
    logger.warn({ err, pattern }, "preCommentHooks: invalid bodyMatches regex, skipping hook");
    return null;
  }
}

interface CandidateMatch {
  hookIndex: number;
  hook: PreCommentHookConfig;
  matchedBy: PreCommentHookMatch["matchedBy"];
  trigger: PreCommentHookTrigger;
}

function matchHookCandidate(
  hook: PreCommentHookConfig,
  hookIndex: number,
  ctx: PreCommentHookContext,
): CandidateMatch | null {
  if (!hook.action) return null;
  const trigger = hook.trigger ?? {};
  const matchedBy = {
    agentId: !trigger.agentId || trigger.agentId === ctx.agentId,
    statusTransition: !trigger.statusTransition || trigger.statusTransition === "any" || trigger.statusTransition === ctx.statusTransition,
    bodyMatches: true as boolean,
  };
  if (trigger.bodyMatches) {
    const re = compileBodyRegex(trigger.bodyMatches);
    if (!re) return null;
    matchedBy.bodyMatches = re.test(ctx.body);
  }
  if (!matchedBy.agentId || !matchedBy.statusTransition || !matchedBy.bodyMatches) {
    return null;
  }
  return { hookIndex, hook, matchedBy, trigger };
}

function truncateForAudit(s: string): string {
  if (s.length <= EXEC_STREAM_CAPTURE_MAX_BYTES) return s;
  return s.slice(0, EXEC_STREAM_CAPTURE_MAX_BYTES) + `\n…[truncated, ${s.length - EXEC_STREAM_CAPTURE_MAX_BYTES} bytes dropped]`;
}

function resolveExecVerdict(
  outcome: Pick<ExecOutcome, "status" | "exitCode">,
  onExit: Record<string, ExecOnExitVerdict>,
): { verdict: ExecOnExitVerdict; source: string } {
  if (outcome.status === "denied") return { verdict: "block", source: "denied" };
  if (outcome.status === "spawn_error") return { verdict: "block", source: "spawn_error" };
  if (outcome.status === "timeout") return { verdict: "block", source: "timeout" };
  // status === "exit"
  const key = outcome.exitCode === null ? "default" : String(outcome.exitCode);
  if (onExit[key]) return { verdict: onExit[key], source: `exit:${key}` };
  if (onExit["default"]) return { verdict: onExit["default"], source: "default" };
  return { verdict: "block", source: "no_mapping" };
}

function verdictToResolvedAction(verdict: ExecOnExitVerdict): ResolvedAction {
  if (verdict === "pass+append_audit") return "pass";
  if (verdict === "warn") return "warn";
  if (verdict === "block") return "block";
  if (verdict === "block+escalate") return "escalate";
  return "block";
}

async function runExecHook(
  hook: PreCommentHookConfig,
  ctx: PreCommentHookContext,
  allowlist: ReadonlySet<string>,
): Promise<ExecOutcome> {
  const startedAt = Date.now();
  const cmd = hook.command;
  if (!cmd || cmd.length === 0) {
    return {
      status: "spawn_error",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "missing command",
      durationMs: 0,
      verdict: "block",
      verdictSource: "spawn_error",
    };
  }
  const resolvedCmd = path.isAbsolute(cmd[0]) ? path.resolve(cmd[0]) : cmd[0];
  if (!path.isAbsolute(resolvedCmd) || !allowlist.has(resolvedCmd)) {
    return {
      status: "denied",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `command not on allowlist: ${resolvedCmd}`,
      durationMs: 0,
      verdict: "block",
      verdictSource: "denied",
    };
  }
  const args = cmd.slice(1);
  const timeoutMs = hook.timeoutMs ?? EXEC_TIMEOUT_DEFAULT_MS;

  return new Promise<ExecOutcome>((resolve) => {
    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let killedByTimeout = false;

    const child = spawn(resolvedCmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PAPERCLIP_HOOK_SOURCE: ctx.source, PAPERCLIP_HOOK_AGENT_ID: ctx.agentId ?? "" },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      killedByTimeout = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — child may already have exited
      }
    }, timeoutMs);

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdoutBuf.length < EXEC_STREAM_CAPTURE_MAX_BYTES) {
        stdoutBuf += chunk;
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderrBuf.length < EXEC_STREAM_CAPTURE_MAX_BYTES) {
        stderrBuf += chunk;
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "spawn_error",
        exitCode: null,
        signal: null,
        stdout: truncateForAudit(stdoutBuf),
        stderr: truncateForAudit(stderrBuf || String(err)),
        durationMs: Date.now() - startedAt,
        verdict: "block",
        verdictSource: "spawn_error",
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status: ExecOutcome["status"] = killedByTimeout ? "timeout" : "exit";
      const partialOutcome = { status, exitCode: code ?? null };
      const { verdict, source } = resolveExecVerdict(
        partialOutcome,
        hook.onExit ?? DEFAULT_ON_EXIT,
      );
      resolve({
        status,
        exitCode: code ?? null,
        signal: signal ?? null,
        stdout: truncateForAudit(stdoutBuf),
        stderr: truncateForAudit(stderrBuf),
        durationMs: Date.now() - startedAt,
        verdict,
        verdictSource: source,
      });
    });

    if (hook.stdin === "comment.body") {
      try {
        child.stdin?.write(ctx.body, "utf8", () => {
          try { child.stdin?.end(); } catch { /* ignore */ }
        });
      } catch {
        // ignore — child may have exited before stdin write
      }
    } else {
      try { child.stdin?.end(); } catch { /* ignore */ }
    }
  });
}

export function buildAuditBlock(
  matches: PreCommentHookMatch[],
  ctx: PreCommentHookContext,
): string {
  const header = `<!-- pre-comment-hook v1 source=${ctx.source} agent=${ctx.agentId ?? "none"} -->`;
  const footer = "<!-- /pre-comment-hook -->";
  const lines: string[] = [];
  for (const m of matches) {
    const trig = m.trigger;
    const parts = [
      `hook[${m.hookIndex}]`,
      `action=${m.action}`,
      m.action === "exec" ? `resolvedAction=${m.resolvedAction}` : null,
      trig.agentId ? `agentId=${trig.agentId}` : null,
      trig.statusTransition ? `statusTransition=${trig.statusTransition}` : null,
      trig.bodyMatches ? `bodyMatches=${trig.bodyMatches}` : null,
      m.message ? `message=${m.message}` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" ")}`);
    if (m.exec) {
      const ex = m.exec;
      lines.push(
        `  exec status=${ex.status} exitCode=${ex.exitCode ?? "n/a"} signal=${ex.signal ?? "n/a"} durationMs=${ex.durationMs} verdict=${ex.verdict} verdictSource=${ex.verdictSource}`,
      );
      if (ex.verdict === "pass+append_audit" && ex.stdout.length > 0) {
        lines.push("  exec stdout:");
        for (const line of ex.stdout.split("\n")) {
          lines.push(`    ${line}`);
        }
      } else if (ex.stderr.length > 0 && (ex.status !== "exit" || ex.exitCode !== 0)) {
        lines.push("  exec stderr:");
        for (const line of ex.stderr.split("\n")) {
          lines.push(`    ${line}`);
        }
      }
    }
  }
  return [header, ...lines, footer].join("\n");
}

export async function evaluatePreCommentHooks(
  db: Db,
  hooks: PreCommentHookConfig[],
  ctx: PreCommentHookContext,
  options?: { execAllowlist?: ReadonlySet<string> },
): Promise<PreCommentHookEvaluation> {
  if (!hooks || hooks.length === 0) {
    return { blocked: false, matches: [] };
  }
  const candidates: CandidateMatch[] = [];
  for (let i = 0; i < hooks.length; i++) {
    const c = matchHookCandidate(hooks[i], i, ctx);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) {
    return { blocked: false, matches: [] };
  }

  const allowlist = options?.execAllowlist ?? readExecAllowlist();

  const matches: PreCommentHookMatch[] = [];
  for (const c of candidates) {
    if (c.hook.action === "exec") {
      const exec = await runExecHook(c.hook, ctx, allowlist);
      const resolvedAction = verdictToResolvedAction(exec.verdict);
      matches.push({
        hookIndex: c.hookIndex,
        action: "exec",
        resolvedAction,
        message: c.hook.message ?? null,
        matchedBy: c.matchedBy,
        trigger: c.trigger,
        exec,
      });
    } else {
      const action = c.hook.action!;
      matches.push({
        hookIndex: c.hookIndex,
        action,
        resolvedAction: action === "escalate" ? "escalate" : action,
        message: c.hook.message ?? null,
        matchedBy: c.matchedBy,
        trigger: c.trigger,
      });
    }
  }

  // Blocking is purely action=block (PR #5170 contract: escalate alone does NOT block).
  // Exec verdict block+escalate is a special combo that also blocks (in addition to its
  // escalation signal); we check via exec.verdict rather than collapsing into resolvedAction.
  const blocked = matches.some(
    (m) =>
      m.resolvedAction === "block" ||
      (m.exec && m.exec.verdict === "block+escalate"),
  );
  const auditBlock = buildAuditBlock(matches, ctx);

  for (const m of matches) {
    // When the overall evaluation blocks AND this individual match is non-blocking
    // (warn/escalate co-fired alongside a block), the conventional "warned"/"escalated"
    // log key would mislead operators into thinking the comment was allowed. Re-route
    // to a disposition-aware key so the activity log reflects the actual outcome.
    // For exec actions, use m.resolvedAction (verdict-mapped) instead of m.action.
    // block+escalate is the only exec-verdict combo that BOTH blocks AND escalates —
    // log as escalated (louder signal) rather than blocked.
    const isBlockEscalateCombo =
      m.action === "exec" && m.exec?.verdict === "block+escalate";
    const isBlockingMatch = m.resolvedAction === "block" || isBlockEscalateCombo;
    let activityKey: string;
    if (isBlockEscalateCombo && blocked) {
      activityKey = "issue.pre_comment_hook_escalated";
    } else if (isBlockingMatch && blocked) {
      activityKey = "issue.pre_comment_hook_blocked";
    } else if (blocked) {
      // Block co-fired with this non-blocking match → log as suppressed/matched-only,
      // not warned/escalated (the comment was actually blocked).
      activityKey = "issue.pre_comment_hook_matched";
    } else if (m.resolvedAction === "warn") {
      activityKey = "issue.pre_comment_hook_warned";
    } else if (m.resolvedAction === "escalate") {
      activityKey = "issue.pre_comment_hook_escalated";
    } else {
      activityKey = "issue.pre_comment_hook_matched";
    }
    try {
      await logActivity(db, {
        companyId: ctx.companyId,
        actorType: "system",
        actorId: "pre_comment_hook",
        agentId: ctx.agentId ?? null,
        runId: null,
        action: activityKey,
        entityType: "issue",
        entityId: ctx.issueId,
        details: {
          source: ctx.source,
          statusTransition: ctx.statusTransition,
          hookIndex: m.hookIndex,
          action: m.action,
          resolvedAction: m.resolvedAction,
          trigger: m.trigger,
          message: m.message,
          auditBlock,
          exec: m.exec
            ? {
                status: m.exec.status,
                exitCode: m.exec.exitCode,
                signal: m.exec.signal,
                durationMs: m.exec.durationMs,
                verdict: m.exec.verdict,
                verdictSource: m.exec.verdictSource,
              }
            : undefined,
        },
      });
    } catch (err) {
      logger.warn({ err, issueId: ctx.issueId }, "preCommentHooks: failed to log activity");
    }
  }

  return { blocked, matches };
}
