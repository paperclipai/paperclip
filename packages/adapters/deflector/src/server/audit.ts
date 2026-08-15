import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  runId: string;
  agentId: string;
  companyId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  matched: boolean;
  patternId: string | null;
  confidence: string | null;
  reason: string;
  action: "resolved" | "skipped" | "dry_run" | "error";
  detail?: Record<string, unknown>;
}

export function appendAudit(auditPath: string, entry: AuditEntry): void {
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
}
