/**
 * Seed Deflector KB SQLite from built-in high-confidence patterns.
 *
 * Usage:
 *   pnpm --filter @paperclipai/adapter-deflector seed:kb
 *   DEFLECTOR_KB_PATH=/path/to/kb.sqlite pnpm --filter @paperclipai/adapter-deflector seed:kb
 *
 * Phase 0 mining notes (2026-08-15 against goc.yaaver.com, GET-only):
 * - AIP: 8601 issues (1164 stranded_issue_recovery)
 * - ONS: 2261 issues (616 stranded_issue_recovery)
 * - Safe auto-resolve heuristic: originKind=stranded_issue_recovery + title
 *   Recover stalled/missing + origin status done|cancelled (~575 AIP cases).
 * - Wazir watchlog/kb mined for known bugs; list-endpoint staleness is ops noise,
 *   not a safe issue auto-resolve pattern, so it was not seeded.
 */
import { defaultKbPath, SEED_PATTERNS } from "../src/server/match.js";
import { openKb, upsertPatterns } from "../src/server/kb.js";

const kbPath = process.env.DEFLECTOR_KB_PATH?.trim() || defaultKbPath();
const db = openKb(kbPath);
upsertPatterns(db, SEED_PATTERNS);
const count = db.prepare("SELECT COUNT(*) AS c FROM patterns").get() as { c: number };
db.close();
console.log(`Seeded ${SEED_PATTERNS.length} patterns into ${kbPath} (table rows=${count.c})`);
