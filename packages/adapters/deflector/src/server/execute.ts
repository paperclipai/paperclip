import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { appendAudit } from "./audit.js";
import { defaultAuditPath, defaultKbPath, matchIssue } from "./match.js";
import { loadPatterns, openKb, seedKbIfEmpty } from "./kb.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveApiBase(config: Record<string, unknown>, context: Record<string, unknown>): string {
  const fromConfig = asString(config.apiBaseUrl, "").replace(/\/+$/, "");
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
  if (fromEnv) return fromEnv;
  const fromContext = asString(context.apiBaseUrl, "").replace(/\/+$/, "");
  return fromContext || "http://127.0.0.1:3100";
}

async function apiFetch(
  base: string,
  path: string,
  opts: {
    method?: string;
    token?: string;
    runId?: string;
    body?: unknown;
  },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.runId) headers["X-Paperclip-Run-Id"] = opts.runId;

  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function renderComment(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;
  const kbPath = asString(config.kbPath, defaultKbPath());
  const auditPath = asString(config.auditPath, defaultAuditPath());
  const dryRun = asBoolean(config.dryRun, false);
  const apiBase = resolveApiBase(config, context);

  if (onMeta) {
    await onMeta({
      adapterType: "deflector_local",
      command: "deflector-match",
      cwd: process.cwd(),
      commandArgs: [],
      env: {
        PAPERCLIP_RUN_ID: runId,
        DEFLECTOR_KB_PATH: kbPath,
        DEFLECTOR_DRY_RUN: dryRun ? "1" : "0",
      },
    });
  }

  const paperclipIssue = parseObject(context.paperclipIssue);
  const issueId =
    asString(paperclipIssue.id, "") ||
    asString(context.issueId, "") ||
    asString(context.taskId, "");

  if (!issueId) {
    await onLog("stdout", "Deflector: no assigned issue in context; nothing to check.\n");
    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId: null,
      issueIdentifier: null,
      matched: false,
      patternId: null,
      confidence: null,
      reason: "no issue in context",
      action: "skipped",
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Deflector skipped (no issue context)",
    };
  }

  const token = authToken || process.env.PAPERCLIP_API_KEY || "";
  if (!token) {
    await onLog("stderr", "Deflector: missing API token; refusing to act.\n");
    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId,
      issueIdentifier: asString(paperclipIssue.identifier, "") || null,
      matched: false,
      patternId: null,
      confidence: null,
      reason: "missing API token",
      action: "error",
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Deflector missing API token",
      errorCode: "deflector_auth_missing",
    };
  }

  const issueRes = await apiFetch(apiBase, `/api/issues/${issueId}`, { token, runId });
  if (!issueRes.ok || !issueRes.json || typeof issueRes.json !== "object") {
    await onLog("stderr", `Deflector: failed to load issue ${issueId} (HTTP ${issueRes.status}).\n`);
    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId,
      issueIdentifier: null,
      matched: false,
      patternId: null,
      confidence: null,
      reason: `GET issue failed HTTP ${issueRes.status}`,
      action: "error",
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to load issue ${issueId}`,
      errorCode: "deflector_issue_fetch_failed",
    };
  }

  const issue = issueRes.json as Record<string, unknown>;
  const originId = asString(issue.originId, "") || null;
  let originStatus: string | null = null;
  if (originId) {
    const originRes = await apiFetch(apiBase, `/api/issues/${originId}`, { token, runId });
    if (originRes.ok && originRes.json && typeof originRes.json === "object") {
      originStatus = asString((originRes.json as Record<string, unknown>).status, "") || null;
    }
  }

  const db = openKb(kbPath);
  try {
    seedKbIfEmpty(db);
    const patterns = loadPatterns(db);
    const match = matchIssue(patterns, {
      issue: {
        id: asString(issue.id, issueId),
        identifier: asString(issue.identifier, "") || null,
        title: asString(issue.title, asString(paperclipIssue.title, "")),
        description: asString(issue.description, "") || null,
        originKind: asString(issue.originKind, "") || null,
        originId,
        companyId: asString(issue.companyId, agent.companyId) || null,
        status: asString(issue.status, "") || null,
      },
      originStatus,
    });

    await onLog(
      "stdout",
      `Deflector: issue=${asString(issue.identifier, issueId)} originKind=${asString(issue.originKind, "-")} originStatus=${originStatus ?? "-"} -> ${match.reason}\n`,
    );

    if (!match.matched || !match.pattern) {
      // Release assignment so the issue can proceed to a normal agent.
      if (!dryRun) {
        await apiFetch(apiBase, `/api/issues/${issueId}`, {
          method: "PATCH",
          token,
          runId,
          body: {
            comment:
              "Deflector: no high-confidence pattern matched. Releasing assignment for normal routing.",
            assigneeAgentId: null,
          },
        });
      }
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        issueIdentifier: asString(issue.identifier, "") || null,
        matched: false,
        patternId: null,
        confidence: null,
        reason: match.reason,
        action: dryRun ? "dry_run" : "released",
        detail: { originKind: issue.originKind, originStatus },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `Deflector pass-through: ${match.reason}`,
        resultJson: { matched: false, reason: match.reason },
      };
    }

    const pattern = match.pattern;
    const comment = renderComment(pattern.commentTemplate, {
      originStatus: originStatus ?? "unknown",
      patternId: pattern.id,
      issueIdentifier: asString(issue.identifier, issueId),
    });

    if (dryRun) {
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        issueIdentifier: asString(issue.identifier, "") || null,
        matched: true,
        patternId: pattern.id,
        confidence: pattern.confidence,
        reason: match.reason,
        action: "dry_run",
        detail: { wouldStatus: pattern.resolutionStatus, comment },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `Deflector dry-run match: ${pattern.id}`,
        resultJson: { matched: true, patternId: pattern.id, dryRun: true },
      };
    }

    const patch = await apiFetch(apiBase, `/api/issues/${issueId}`, {
      method: "PATCH",
      token,
      runId,
      body: {
        status: pattern.resolutionStatus,
        comment,
      },
    });

    if (!patch.ok) {
      await onLog("stderr", `Deflector: PATCH failed HTTP ${patch.status}\n`);
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        issueIdentifier: asString(issue.identifier, "") || null,
        matched: true,
        patternId: pattern.id,
        confidence: pattern.confidence,
        reason: `PATCH failed HTTP ${patch.status}`,
        action: "error",
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Deflector PATCH failed HTTP ${patch.status}`,
        errorCode: "deflector_patch_failed",
      };
    }

    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId,
      issueIdentifier: asString(issue.identifier, "") || null,
      matched: true,
      patternId: pattern.id,
      confidence: pattern.confidence,
      reason: match.reason,
      action: "resolved",
      detail: { status: pattern.resolutionStatus, originStatus },
    });

    await onLog("stdout", `Deflector: resolved via ${pattern.id}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `Deflector resolved: ${pattern.id}`,
      resultJson: {
        matched: true,
        patternId: pattern.id,
        status: pattern.resolutionStatus,
      },
    };
  } finally {
    db.close();
  }
}
