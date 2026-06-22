/**
 * Inventory live agents and propagate the Sprint-1A Cherny workflow sections (self-correction
 * loop, verification, demand-elegance) into their instruction entry file (AGENTS.md).
 *
 * Idempotent + append-only: a section is appended only if its heading marker is absent.
 * Re-running is a no-op; never clobbers custom content.
 *
 * Two storage backends exist:
 *  - DB-backed bundle (agents.instruction_bundle): this script appends + writes it on --apply.
 *  - Volume-path agents (no DB bundle; instructions live on the Railway volume): this script
 *    REPORTS them (companyId + instructionsRootPath). The Vercel API can't write the Railway
 *    volume, so those are patched on the host via `railway ssh` (append guarded by the
 *    `cherny-sprint-1a` sentinel). The founding fleet (Ti Claude/Sol/Bati/Veye) is volume-path.
 *
 * Run with DATABASE_URL injected (never printed):
 *   railway run -s <svc> ./cli/node_modules/.bin/tsx scripts/propagate-cherny-sections.ts          # DRY RUN
 *   railway run -s <svc> ./cli/node_modules/.bin/tsx scripts/propagate-cherny-sections.ts --apply  # write DB bundles
 * Imports the built db package by path (workspace name does not resolve from scripts/ under tsx).
 */
import { createDb, agents } from "../packages/db/dist/index.js";

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (run via `railway run`)");
const db = createDb(url);

const TARGET_NAMES = ["ti claude", "sol", "bati", "veye"];

const SECTIONS: Array<{ marker: string; body: string }> = [
  {
    marker: "## Verification before done",
    body: `## Verification before done

- Never mark a task \`done\` without proving it works -- run the tests, check the logs,
  demonstrate the correct behavior. Evidence of the result, not just "I made the change".
- When the change alters behavior, diff the new behavior against the baseline.
- Before you hand off, ask yourself: "would a staff engineer in this discipline approve this?"
  If not, it is not done.`,
  },
  {
    marker: "## Craft -- demand elegance",
    body: `## Craft -- demand elegance (balanced)

- For a non-trivial change, pause and ask "is there a more elegant way?" before committing to an approach.
- If a fix feels hacky, redo it: "knowing everything I know now, implement the clean solution."
- Skip this for simple, obvious fixes -- do not over-engineer.
- Challenge your own work before you present it.`,
  },
  {
    marker: "## Self-correction",
    body: `## Self-correction

- At the start of a run, read the \`## Lessons\` section of \`$AGENT_HOME/MEMORY.md\` (create the
  file with that heading if it does not exist). Treat each lesson as a standing rule.
- When the board, a reviewer, QA, or a failed check corrects you, append a one-line rule
  immediately: \`- YYYY-MM-DD -- <trigger> -> <rule>\`. This is how you stop repeating mistakes
  across sessions. You cannot edit these instructions (they are board-managed) -- your lessons
  live in your writable \`MEMORY.md\`.`,
  },
];

type BundleFile = { path: string; content: string };
type Bundle = { entryFile: string; files: BundleFile[] };

function asBundle(value: unknown): Bundle | null {
  if (!value || typeof value !== "object") return null;
  const b = value as { entryFile?: unknown; files?: unknown };
  if (!Array.isArray(b.files)) return null;
  const files = b.files.filter(
    (f): f is BundleFile =>
      !!f && typeof (f as BundleFile).path === "string" && typeof (f as BundleFile).content === "string",
  );
  if (files.length === 0) return null;
  const entryFile = typeof b.entryFile === "string" && b.entryFile ? b.entryFile : "AGENTS.md";
  return { entryFile, files };
}

const all = await db.select().from(agents);
const targets = all.filter((a) => TARGET_NAMES.includes(String(a.name).trim().toLowerCase()));

console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
console.log(`Agents in DB: ${all.length} | matched targets: ${targets.map((t) => t.name).join(", ") || "(none)"}\n`);

for (const want of TARGET_NAMES) {
  if (!targets.some((t) => String(t.name).trim().toLowerCase() === want)) {
    console.log(`  ⚠️  target "${want}" NOT FOUND in DB`);
  }
}

for (const agent of targets) {
  const bundle = asBundle((agent as { instructionBundle?: unknown }).instructionBundle);
  if (!bundle) {
    const cfg = ((agent as { adapterConfig?: unknown }).adapterConfig ?? {}) as Record<string, unknown>;
    // Paths only — never print the rest of adapterConfig (may hold provider secrets).
    console.log(`\n[${agent.name}] (${agent.id}) — NO DB bundle → volume path`);
    console.log(`    companyId: ${agent.companyId}`);
    console.log(`    instructionsRootPath: ${cfg.instructionsRootPath ?? "(unset)"}`);
    console.log(`    instructionsEntryFile: ${cfg.instructionsEntryFile ?? "AGENTS.md"}`);
    continue;
  }
  const entry = bundle.files.find((f) => f.path === bundle.entryFile) ?? bundle.files[0];
  if (!entry) {
    console.log(`\n[${agent.name}] — bundle has no entry file. Skipped.`);
    continue;
  }
  const missing = SECTIONS.filter((s) => !entry.content.includes(s.marker));
  console.log(`\n[${agent.name}] (${agent.id}) entry=${entry.path}`);
  if (missing.length === 0) {
    console.log(`  ✓ already has all sections — no change`);
    continue;
  }
  console.log(`  + appending: ${missing.map((m) => m.marker).join(", ")}`);

  if (apply) {
    const appended = `${entry.content.replace(/\s*$/, "")}\n\n${missing.map((m) => m.body).join("\n\n")}\n`;
    const nextFiles = bundle.files.map((f) => (f.path === entry.path ? { ...f, content: appended } : f));
    const nextBundle: Bundle = { entryFile: bundle.entryFile, files: nextFiles };
    const { eq } = await import("drizzle-orm");
    await db
      .update(agents)
      .set({ instructionBundle: nextBundle, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
    console.log(`  ✅ written`);
  }
}

console.log(`\n${apply ? "Applied." : "Dry run complete — re-run with --apply to write."}`);
process.exit(0);
