/**
 * scripts/count-needs-you-views.ts
 *
 * PAP-749 task 1a deliverable: "count how many local cards go into each view".
 *
 * It spins up a throwaway, migrated embedded Postgres, runs the Needs You demo
 * seed (scripts/seed-needs-you-demo.ts) into it, then runs the attention feed
 * for each demo user under every view= value and prints the card counts. The
 * demo company is the canonical "local" card set for the integration branch's
 * preview, so this quantifies the audience migration impact before task 1b
 * flips the default view in the UI.
 *
 * Run from the repo root (resolves server deps via the server package):
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/count-needs-you-views.ts
 *
 * Read-condition note: the feed is listed with no actor, i.e. full board read
 * visibility, which matches the board operator the Needs You page runs as.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createDb,
  startEmbeddedPostgresTestDatabase,
  authUsers,
  companies as companiesTable,
} from "../packages/db/src/index.js";
import type { AttentionFeedView } from "../packages/shared/src/index.js";
import { attentionService } from "../server/src/services/attention.js";
import { expirePendingInteractionsOnClosedIssues } from "../server/src/services/closed-issue-interaction-sweep.js";

// Repo-root scripts can't resolve server-only bare deps directly, so pull
// drizzle's helpers through the server package (see the seed script).
const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
const { eq, inArray } = serverRequire("drizzle-orm") as typeof import("drizzle-orm");

const DEMO_COMPANY_NAME = "Needs You Demo";
const DEMO_EMAILS: Record<string, string> = {
  Scott: "scott@needs-you-demo.test",
  Dotta: "dotta@needs-you-demo.test",
  Riley: "riley@needs-you-demo.test",
};
const VIEWS: AttentionFeedView[] = ["all", "mine", "unassigned", "company"];

async function main() {
  const tempDb = await startEmbeddedPostgresTestDatabase("needs-you-counts-");
  try {
    const seedScript = fileURLToPath(new URL("./seed-needs-you-demo.ts", import.meta.url));
    const tsxBin = fileURLToPath(new URL("../server/node_modules/tsx/dist/cli.mjs", import.meta.url));
    const seedRun = spawnSync(process.execPath, [tsxBin, seedScript], {
      env: { ...process.env, DATABASE_URL: tempDb.connectionString },
      stdio: "inherit",
    });
    if (seedRun.status !== 0) throw new Error(`seed exited with status ${seedRun.status}`);

    const db = createDb(tempDb.connectionString);
    const [company] = await db
      .select({ id: companiesTable.id, prefix: companiesTable.issuePrefix })
      .from(companiesTable)
      .where(eq(companiesTable.name, DEMO_COMPANY_NAME));
    if (!company) throw new Error("demo company not found after seed");

    const userRows = await db
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .where(inArray(authUsers.email, Object.values(DEMO_EMAILS)));
    const idByEmail = new Map(userRows.map((row) => [row.email, row.id]));

    const svc = attentionService(db);
    // Task 2a: stale cards by reason, for Scott's full feed.
    const printStale = async (label: string) => {
      const scott = idByEmail.get(DEMO_EMAILS.Scott);
      if (!scott) return;
      const feed = await svc.list(company.id, { userId: scott, view: "all" });
      const stale = feed.items.filter((item) => item.stale);
      console.log(`\n[${label}] Scott view=all: ${feed.totalCount} card(s), ${stale.length} stale`);
      for (const item of stale) {
        console.log(`  - ${item.stale!.reason.padEnd(17)} ${item.audience.kind.padEnd(7)} ${item.sourceKind}: ${item.subject.title}`);
      }
    };
    await printStale("before startup sweep");
    // Task 2a Rule 9: which of Scott's personally hidden cards stay hidden.
    const scottForHidden = idByEmail.get(DEMO_EMAILS.Scott);
    if (scottForHidden) {
      const withHidden = await svc.list(company.id, { userId: scottForHidden, view: "all", includeDismissed: true });
      console.log("\n[hidden] Scott's archived/snoozed cards:");
      for (const item of withHidden.items.filter((entry) => entry.dismissal)) {
        console.log(`  - ${item.dismissal!.isActive ? "hidden  " : "returned"} ${item.dismissal!.kind.padEnd(7)} ${item.subject.title}`);
      }
    }
    // A server start runs the closed-task sweep once; run it twice to show it is idempotent.
    console.log(`\n[sweep] first run:  ${JSON.stringify(await expirePendingInteractionsOnClosedIssues(db))}`);
    console.log(`[sweep] second run: ${JSON.stringify(await expirePendingInteractionsOnClosedIssues(db))}`);
    await printStale("after startup sweep");

    console.log(`\n=== Needs You demo card counts by view (company ${company.id}, prefix ${company.prefix}) ===`);
    console.log("user   | all | mine | unassigned | company");
    console.log("-------+-----+------+------------+--------");
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) {
        console.log(`${name.padEnd(6)} | (user not found)`);
        continue;
      }
      const counts: Record<string, number> = {};
      for (const view of VIEWS) {
        const feed = await svc.list(company.id, { userId, view });
        counts[view] = feed.totalCount;
      }
      console.log(
        `${name.padEnd(6)} | ${String(counts.all).padStart(3)} | ${String(counts.mine).padStart(4)} | ` +
        `${String(counts.unassigned).padStart(10)} | ${String(counts.company).padStart(7)}`,
      );
    }

    // Per-source-kind breakdown for Scott's mine view, to show the composition.
    const scottId = idByEmail.get(DEMO_EMAILS.Scott);
    if (scottId) {
      for (const view of VIEWS) {
        const feed = await svc.list(company.id, { userId: scottId, view });
        const nonZero = Object.entries(feed.countsBySourceKind).filter(([, n]) => n > 0);
        console.log(`\n[Scott view=${view}] ${feed.totalCount} card(s): ${nonZero.map(([k, n]) => `${k}=${n}`).join(", ") || "none"}`);
      }
    }

    await (db as unknown as { $client: { end: (o?: { timeout?: number }) => Promise<void> } }).$client.end({ timeout: 5 });
  } finally {
    await tempDb.cleanup();
  }
}

await main();
