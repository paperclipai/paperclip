export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseDeflectorStdout } from "./parse.js";
export {
  matchIssue,
  SEED_PATTERNS,
  defaultKbPath,
  defaultAuditPath,
  TERMINAL_STATUSES,
} from "./match.js";
export type { PatternRule, MatchCandidate, MatchResult, ConfidenceTier } from "./match.js";
export { openKb, seedKbIfEmpty, loadPatterns, upsertPatterns } from "./kb.js";
export { appendAudit } from "./audit.js";
export type { AuditEntry } from "./audit.js";
