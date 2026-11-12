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
import { attentionReceiptService } from "../server/src/services/attention-receipts.js";
import { decisionHistoryService } from "../server/src/services/decision-history.js";
import { issueService } from "../server/src/services/issues.js";
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
    // `badge` is the shared For you badge (task 1b). The columns count cards;
    // the badge counts obligations, so it is `mine` minus folded evidence (task 2d).
    console.log("user   | all | mine | unassigned | company | badge");
    console.log("-------+-----+------+------------+---------+------");
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) {
        console.log(`${name.padEnd(6)} | (user not found)`);
        continue;
      }
      const counts: Record<string, number> = {};
      let badge = 0;
      for (const view of VIEWS) {
        const feed = await svc.list(company.id, { userId, view });
        counts[view] = feed.totalCount;
        badge = feed.deskBadgeCount;
      }
      console.log(
        `${name.padEnd(6)} | ${String(counts.all).padStart(3)} | ${String(counts.mine).padStart(4)} | ` +
        `${String(counts.unassigned).padStart(10)} | ${String(counts.company).padStart(7)} | ${String(badge).padStart(5)}`,
      );
    }

    // Task 2c: the collapsed Stale (N) group in each view, and what "Withdraw
    // all stale" would close: cards whose closeModes include withdraw and that
    // are not required gates (required approvals and governed requests stay).
    console.log("\n=== Stale group per view (task 2c) ===");
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) continue;
      for (const view of ["mine", "unassigned", "company"] as const) {
        const feed = await svc.list(company.id, { userId, view });
        const stale = feed.items.filter((item) => item.stale);
        if (!stale.length) continue;
        const bulk = (item: (typeof stale)[number]) => item.closeModes.includes("withdraw") && !item.required;
        console.log(`${name} view=${view}: Stale (${stale.length}), Withdraw all stale closes ${stale.filter(bulk).length}`);
        for (const item of stale) {
          const verb = bulk(item) ? "withdraw" : item.required ? "required" : "stays   ";
          console.log(`  - ${verb} ${item.stale!.reason.padEnd(17)} ${item.sourceKind}: ${item.subject.title}`);
        }
      }
    }

    // Receipts at the top of For you, and tasks unread in Mine (task 2f).
    console.log("\n=== Receipts (task 2f) ===");
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) continue;
      const actor = { type: "board", source: "session", userId, companyIds: [company.id], isInstanceAdmin: true } as never;
      const receipts = await attentionReceiptService(db).list(company.id, { userId, actor });
      const unread = await issueService(db).list(company.id, { unreadForUserId: userId });
      console.log(`${name}: ${receipts.length} receipt(s); unread in Mine: ${unread.map((issue) => issue.title).join(", ") || "none"}`);
      for (const receipt of receipts) {
        console.log(`  - ${receipt.outcome.padEnd(9)} by ${receipt.actorUserId === idByEmail.get(DEMO_EMAILS.Scott) ? "Scott" : receipt.actorUserId}: ${receipt.title}${receipt.reason ? ` (reason: ${receipt.reason})` : ""}`);
      }
    }

    // Task 2e: each person's Archived view (archived first, then the Snoozed
    // group) and its tab count, which is never in the badge; then the Decision
    // history outcome filters, approvals included.
    console.log("\n=== Archived view (task 2e) ===");
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) continue;
      const feed = await svc.list(company.id, { userId, view: "archived" });
      console.log(`${name}: Archived tab ${feed.viewCounts.archived}, badge ${feed.deskBadgeCount} (= For you ${feed.viewCounts.mine})`);
      for (const item of feed.items) {
        const when = item.dismissal!.kind === "snooze" ? `snoozed, back ${item.dismissal!.snoozedUntil}` : `archived ${item.dismissal!.dismissedAt}`;
        console.log(`  - ${when}${item.stale ? ` · stale ${item.stale.reason}` : ""}: ${item.subject.title}`);
      }
    }
    if (scottForHidden) {
      const actor = { type: "board", source: "session", userId: scottForHidden, companyIds: [company.id], isInstanceAdmin: true } as never;
      const history = decisionHistoryService(db);
      console.log("\n=== Decision history filters for Scott (task 2e) ===");
      for (const outcome of [undefined, "withdrawn", "expired", "issue_closed", "accepted", "rejected"]) {
        const page = await history.list(company.id, { actor, userId: scottForHidden, limit: 100, ...(outcome ? { outcome } : {}) });
        const approvals = page.items.filter((item) => item.sourceKind === "approval").length;
        console.log(`${(outcome ?? "all").padEnd(12)} ${String(page.items.length).padStart(3)} entr${page.items.length === 1 ? "y" : "ies"} (${approvals} approval${approvals === 1 ? "" : "s"})`);
        if (outcome) for (const item of page.items) console.log(`  - ${item.sourceKind.padEnd(24)} ${item.label}${item.reason ? ` (reason: ${item.reason})` : ""}: ${item.title}`);
      }
    }

    // Task 2d: one card for each obligation. The feed keeps every card; the
    // page folds evidence into its lead, and the view counts and badge count
    // each obligation once.
    console.log("\n=== One card for each obligation (task 2d) ===");
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) continue;
      const shown: string[] = [];
      for (const view of ["mine", "unassigned", "company"] as const) {
        const feed = await svc.list(company.id, { userId, view, all: true, allowUnscopedAll: true });
        const leads = feed.items.filter((item) => !item.obligationLeadId || item.obligationLeadId === item.id);
        shown.push(`${view} ${feed.items.length} cards -> ${leads.length} shown (count ${feed.viewCounts[view]})`);
      }
      console.log(`${name}: ${shown.join("; ")}`);
    }
    if (scottForHidden) {
      const feed = await svc.list(company.id, { userId: scottForHidden, view: "all", all: true, allowUnscopedAll: true });
      for (const lead of feed.items.filter((item) => item.obligationKey && item.obligationLeadId === item.id)) {
        const place = lead.audience.kind === "user" ? (lead.audience.userId === scottForHidden ? "Scott" : lead.audience.userId) : lead.audience.kind;
        console.log(`  ${lead.obligationKey} -> ${place}: ${lead.sourceKind} "${lead.subject.title}"`);
        for (const evidence of feed.items.filter((item) => item.obligationLeadId === lead.id && item !== lead)) {
          console.log(`      + ${evidence.sourceKind} "${evidence.subject.title}"`);
        }
      }
      const gated = feed.items.filter((item) => item.subject.title?.startsWith("Independent gate") || item.subject.title === "Approve the reviewed task");
      for (const item of gated) console.log(`  separate gate: ${item.sourceKind} "${item.subject.title}" (obligationKey ${item.obligationKey})`);
    }

    // Task 1d: escalation owners. Cards whose "Why me?" is a project or budget
    // owner, and where the budget hard stop shows for each person.
    console.log("\n=== Escalation owners (task 1d) ===");
    const nameById = new Map([...idByEmail].map(([email, id]) => [id, Object.keys(DEMO_EMAILS).find((key) => DEMO_EMAILS[key] === email)!]));
    for (const [name, email] of Object.entries(DEMO_EMAILS)) {
      const userId = idByEmail.get(email);
      if (!userId) continue;
      const mine = await svc.list(company.id, { userId, view: "mine", all: true, allowUnscopedAll: true });
      const company_ = await svc.list(company.id, { userId, view: "company", all: true, allowUnscopedAll: true });
      const owned = mine.items.filter((item) => ["project_owner", "budget_owner", "escalation_owner"].includes(item.audience.reason));
      const hardStop = company_.items.find((item) => item.sourceKind === "budget_alert" && item.subject.metadata?.thresholdType === "hard");
      console.log(`${name}: ${owned.length} escalation card(s) in For you; Company shows the hard stop: ${hardStop ? `yes (for ${hardStop.audience.userId ? `@${nameById.get(hardStop.audience.userId)}` : "operators"})` : "no"}`);
      for (const item of owned) console.log(`  - ${item.audience.reason.padEnd(16)} ${item.sourceKind}: ${item.subject.title} [${item.decisionVerbs.map((verb) => verb.label).join(" / ")}]`);
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
