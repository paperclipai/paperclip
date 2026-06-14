/**
 * Idempotent one-shot: re-seed gate agents (architect / code-reviewer /
 * wiring-expert) that were created before the identity-aware instruction seed
 * (commit cba094b4) and are still stuck on the generic default/AGENTS.md, so the
 * gate agents in an existing company get their real role identity.
 *
 * SAFETY: an agent is re-seeded ONLY when its derived urlKey is a gate role, its
 * bundle is managed, and its current entry file is byte-for-byte the generic
 * default seed. Custom edits, already-role-seeded bundles, external/unmanaged
 * agents, and missing entries are never overwritten. Re-seed deletes and rewrites
 * the agent's live instructions dir, so this is DRY by default — pass --apply to
 * actually write.
 *
 * Usage:
 *   DATABASE_URL=<url> tsx server/scripts/backfill-gate-instructions.ts            # dry run (preview)
 *   DATABASE_URL=<url> tsx server/scripts/backfill-gate-instructions.ts --apply    # write
 */

import { createDb, agents as agentsTable } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { agentService } from "../src/services/agents.js";
import { agentInstructionsService } from "../src/services/agent-instructions.js";
import { loadDefaultAgentInstructionsBundle } from "../src/services/default-agent-instructions.js";
import { decideGateBackfillAction } from "../src/services/gate-instruction-backfill.js";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(databaseUrl);
const agents = agentService(db);
const instructions = agentInstructionsService();

async function main() {
  const defaultEntryContent = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"];

  if (apply) {
    console.log("!! APPLY MODE — live agent instruction dirs WILL be overwritten for matched gate agents.\n");
  } else {
    console.log("Dry run (preview). Re-run with --apply to write.\n");
  }

  const rows = await db.select().from(agentsTable);
  let reseeded = 0;
  let gateSkipped = 0;

  for (const row of rows) {
    const urlKey = normalizeAgentUrlKey(row.name);

    // Resolve current bundle mode + entry content (best-effort; a misconfigured
    // bundle resolves to null and is skipped, never aborting the whole run).
    let mode: "managed" | "external" | null = null;
    let currentEntryContent: string | null = null;
    try {
      const bundle = await instructions.getBundle(row);
      mode = bundle.mode;
      currentEntryContent = await instructions
        .readFile(row, bundle.entryFile)
        .then((f) => f.content)
        .catch(() => null);
    } catch {
      mode = null;
      currentEntryContent = null;
    }

    const decision = decideGateBackfillAction({ urlKey, mode, currentEntryContent, defaultEntryContent });

    if (decision.action === "skip") {
      // Only surface skips for agents that ARE gate agents — a skipped gate agent
      // (custom/entry-missing/unmanaged) may be a broken gate the operator must fix.
      if (typeof urlKey === "string" && decision.reason !== "not-a-gate-agent") {
        console.log(`  [skip] ${row.name} (${row.id}) urlKey=${urlKey} — ${decision.reason}`);
        gateSkipped++;
      }
      continue;
    }

    console.log(`  [reseed] ${row.name} (${row.id}) urlKey=${urlKey} → ${decision.bundleRole} ${apply ? "" : "(would reseed)"}`);
    reseeded++;
    if (!apply) continue;

    const files = await loadDefaultAgentInstructionsBundle(
      decision.bundleRole as Parameters<typeof loadDefaultAgentInstructionsBundle>[0],
    );
    const materialized = await instructions.materializeManagedBundle(row, files, {
      replaceExisting: true,
      entryFile: "AGENTS.md",
    });
    // Persist parity with the create path (routes/agents.ts): clear any legacy
    // prompt-template keys so the managed bundle is the sole instruction source.
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;
    delete nextAdapterConfig.bootstrapPromptTemplate;
    await agents.update(row.id, { adapterConfig: nextAdapterConfig });
  }

  console.log(
    `\nDone. reseeded=${reseeded} gate-skipped=${gateSkipped} scanned=${rows.length} ${apply ? "" : "(DRY RUN — no writes)"}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
