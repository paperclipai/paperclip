import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export type PreCommentHookAction = "block" | "warn" | "escalate";

export interface PreCommentHookTrigger {
  agentId?: string;
  statusTransition?: string;
  bodyMatches?: string;
}

export interface PreCommentHookConfig {
  trigger?: PreCommentHookTrigger;
  action?: PreCommentHookAction;
  message?: string;
}

export interface PreCommentHookContext {
  companyId: string;
  issueId: string;
  agentId: string | null;
  body: string;
  source: "comment" | "update";
  statusTransition: string | null;
}

export interface PreCommentHookMatch {
  hookIndex: number;
  action: PreCommentHookAction;
  message: string | null;
  matchedBy: {
    agentId: boolean;
    statusTransition: boolean;
    bodyMatches: boolean;
  };
  trigger: PreCommentHookTrigger;
}

export interface PreCommentHookEvaluation {
  blocked: boolean;
  matches: PreCommentHookMatch[];
}

const VALID_ACTIONS: ReadonlySet<PreCommentHookAction> = new Set(["block", "warn", "escalate"]);

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    return { trigger, action, message: message ?? undefined };
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

function matchHook(hook: PreCommentHookConfig, ctx: PreCommentHookContext): PreCommentHookMatch | null {
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
  return {
    hookIndex: -1,
    action: hook.action,
    message: hook.message ?? null,
    matchedBy,
    trigger,
  };
}

export function buildAuditBlock(
  matches: PreCommentHookMatch[],
  ctx: PreCommentHookContext,
): string {
  const header = `<!-- pre-comment-hook v1 source=${ctx.source} agent=${ctx.agentId ?? "none"} -->`;
  const footer = "<!-- /pre-comment-hook -->";
  const lines = matches.map((m) => {
    const trig = m.trigger;
    const parts = [
      `hook[${m.hookIndex}]`,
      `action=${m.action}`,
      trig.agentId ? `agentId=${trig.agentId}` : null,
      trig.statusTransition ? `statusTransition=${trig.statusTransition}` : null,
      trig.bodyMatches ? `bodyMatches=${trig.bodyMatches}` : null,
      m.message ? `message=${m.message}` : null,
    ].filter(Boolean);
    return `- ${parts.join(" ")}`;
  });
  return [header, ...lines, footer].join("\n");
}

export async function evaluatePreCommentHooks(
  db: Db,
  hooks: PreCommentHookConfig[],
  ctx: PreCommentHookContext,
): Promise<PreCommentHookEvaluation> {
  if (!hooks || hooks.length === 0) {
    return { blocked: false, matches: [] };
  }
  const matches: PreCommentHookMatch[] = [];
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    const m = matchHook(hook, ctx);
    if (m) {
      matches.push({ ...m, hookIndex: i });
    }
  }
  if (matches.length === 0) {
    return { blocked: false, matches };
  }

  const blocked = matches.some((m) => m.action === "block");
  const auditBlock = buildAuditBlock(matches, ctx);

  for (const m of matches) {
    try {
      await logActivity(db, {
        companyId: ctx.companyId,
        actorType: "system",
        actorId: "pre_comment_hook",
        agentId: ctx.agentId ?? null,
        runId: null,
        action: blocked && m.action === "block"
          ? "issue.pre_comment_hook_blocked"
          : m.action === "warn"
          ? "issue.pre_comment_hook_warned"
          : m.action === "escalate"
          ? "issue.pre_comment_hook_escalated"
          : "issue.pre_comment_hook_matched",
        entityType: "issue",
        entityId: ctx.issueId,
        details: {
          source: ctx.source,
          statusTransition: ctx.statusTransition,
          hookIndex: m.hookIndex,
          action: m.action,
          trigger: m.trigger,
          message: m.message,
          auditBlock,
        },
      });
    } catch (err) {
      logger.warn({ err, issueId: ctx.issueId }, "preCommentHooks: failed to log activity");
    }
  }

  return { blocked, matches };
}
