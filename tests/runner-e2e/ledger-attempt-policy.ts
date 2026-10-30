import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openEvalCostLedger, readEvalCostLedger, type EvalLegacyAttemptAudit } from "./cost-ledger.js";

export interface LegacyAttemptAuditFile extends EvalLegacyAttemptAudit {
  version: 1;
  ledgerPath: string;
  evidencePath: string;
}

export async function adoptLegacyEvalAttemptPolicy(audit: LegacyAttemptAuditFile) {
  const allowed = ["version", "ledgerPath", "evidencePath", "previousJournalHash", "evidenceSha256", "maxAttemptsPerExecution", "priorAttempts"];
  if (!audit || typeof audit !== "object" || Array.isArray(audit) || Object.keys(audit).some(key => !allowed.includes(key))
      || audit.version !== 1 || typeof audit.ledgerPath !== "string" || !path.isAbsolute(audit.ledgerPath)
      || typeof audit.evidencePath !== "string" || !path.isAbsolute(audit.evidencePath)) throw new Error("Invalid legacy attempt audit file");
  const evidence = await readFile(audit.evidencePath);
  if (createHash("sha256").update(evidence).digest("hex") !== audit.evidenceSha256) throw new Error("Legacy attempt audit evidence changed");
  const original = await readEvalCostLedger(audit.ledgerPath);
  if (original.previous !== audit.previousJournalHash) throw new Error("Legacy attempt audit checkpoint changed");
  const ledger = await openEvalCostLedger(audit.ledgerPath, original.state.limits);
  try {
    await ledger.adoptLegacyAttemptPolicy({ previousJournalHash: audit.previousJournalHash, evidenceSha256: audit.evidenceSha256,
      maxAttemptsPerExecution: audit.maxAttemptsPerExecution, priorAttempts: audit.priorAttempts });
  } finally { await ledger.close(); }
  const updated = await readEvalCostLedger(audit.ledgerPath);
  return { journalHash: updated.previous, records: updated.sequence, limits: updated.state.limits, accounting: updated.state.snapshot() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: ledger-attempt-policy.ts /absolute/private-audit.json");
    const result = await adoptLegacyEvalAttemptPolicy(JSON.parse(await readFile(process.argv[2]!, "utf8")));
    process.stdout.write(`Legacy attempt policy saved at journal record ${result.records}. Existing costs and limits are preserved.\n`);
  } catch {
    process.stderr.write("Legacy attempt audit failed. Inspect the private audit and original journal before retrying.\n");
    process.exitCode = 1;
  }
}
