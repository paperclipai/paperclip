/**
 * EVOHAUS AI — Holding Structure Migration
 *
 * Converts EvoHaus from a flat project list to a proper holding company:
 *   - EvoHaus = holding company (parentCompanyId = null)
 *   - 13 projects → subsidiary companies (parentCompanyId = EvoHaus)
 *   - Kosgeb + Skill Scout stay as projects under EvoHaus
 *   - Each company gets CEO / CTO / CFO / COO / CMO org chart
 *   - Issues, project_workspaces, execution_workspaces migrated to new company
 *
 * Run: DATABASE_URL=... npx tsx packages/db/src/migrate-to-holding-structure.ts
 * Idempotent: safe to run multiple times.
 */

import { createDb } from "./client.js";
import { companies, agents, projects, projectWorkspaces, budgetPolicies } from "./schema/index.js";
import { eq, and, isNull, sql } from "drizzle-orm";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);
const rawSql = postgres(url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVOHAUS_ID = "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820";
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

// Projects to convert → companies (slug matches metadata.project from seed)
const SUBSIDIARIES: Array<{
  slug: string;
  name: string;
  issuePrefix: string;
  brandColor: string;
  description: string;
}> = [
  { slug: "mersin-steel", name: "MersinSteel", issuePrefix: "MST", brandColor: "#3b82f6", description: "Celik sektoru muhasebe ve mali yonetim paneli" },
  { slug: "navico", name: "Navico", issuePrefix: "NAV", brandColor: "#10b981", description: "Lojistik filo yonetim ve arac takip sistemi" },
  { slug: "emir", name: "Emir", issuePrefix: "EMR", brandColor: "#f59e0b", description: "Gumruk tarife ve GTIP yonetim sistemi" },
  { slug: "ksatlas", name: "KsAtlas", issuePrefix: "KSA", brandColor: "#6366f1", description: "Dis ticaret muhasebe ve kur takip sistemi" },
  { slug: "celal-isinlik", name: "Celal Isinlik", issuePrefix: "CEL", brandColor: "#84cc16", description: "Imalat sektoru uretim takip ve is emri yonetimi" },
  { slug: "hukukbank", name: "HukukBank", issuePrefix: "HKB", brandColor: "#8b5cf6", description: "Yargitay kararlari arama ve analiz platformu" },
  { slug: "ekstrai", name: "EkstreAI", issuePrefix: "EKS", brandColor: "#06b6d4", description: "Banka ekstresi OCR ve otomatik ayristirma" },
  { slug: "psikoruya", name: "PsikoRuya", issuePrefix: "PSI", brandColor: "#ec4899", description: "B2C ruya analizi ve wellness mobil uygulamasi" },
  { slug: "transaktas", name: "Transaktas", issuePrefix: "TRN", brandColor: "#14b8a6", description: "Nakliye ve kargo takip sistemi" },
  { slug: "vito", name: "Vito", issuePrefix: "VIT", brandColor: "#1e293b", description: "B2C luks otomotiv Bluetooth baglanti iOS uygulamasi" },
  { slug: "mission-control", name: "Mission Control", issuePrefix: "MSC", brandColor: "#f97316", description: "Internal DevOps kontrol paneli ve agent yonetimi" },
  { slug: "vitalix", name: "Vitalix", issuePrefix: "VTL", brandColor: "#22c55e", description: "B2C saglik takip ve HealthKit iOS uygulamasi" },
  { slug: "private-bank", name: "Private Bank", issuePrefix: "PRV", brandColor: "#0ea5e9", description: "Ozel bankacilik dashboard ve finans yonetimi" },
];

// C-suite roles for each company
const C_SUITE = [
  { role: "ceo", title: "Chief Executive Officer", suffix: "CEO", capabilities: "strategic-planning, delegation, org-management, reporting" },
  { role: "cto", title: "Chief Technology Officer", suffix: "CTO", capabilities: "architecture, deployment, security, research, database" },
  { role: "cfo", title: "Chief Financial Officer", suffix: "CFO", capabilities: "financial-planning, budgeting, reporting, cost-optimization" },
  { role: "coo", title: "Chief Operating Officer", suffix: "COO", capabilities: "operations, process-management, team-coordination" },
  { role: "cmo", title: "Chief Marketing Officer", suffix: "CMO", capabilities: "marketing, branding, growth, content-strategy, seo-fundamentals" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function upsertCompany(data: {
  name: string;
  issuePrefix: string;
  description: string;
  brandColor: string;
  parentCompanyId: string;
}): Promise<string> {
  // Check if already exists
  const existing = await rawSql<{ id: string }[]>`
    SELECT id FROM companies WHERE issue_prefix = ${data.issuePrefix} LIMIT 1
  `;
  if (existing.length > 0) {
    console.log(`  [SKIP] ${data.name} already exists`);
    return existing[0]!.id;
  }

  const [row] = await db
    .insert(companies)
    .values({
      name: data.name,
      description: data.description,
      issuePrefix: data.issuePrefix,
      brandColor: data.brandColor,
      parentCompanyId: data.parentCompanyId,
      status: "active",
      budgetMonthlyCents: 0,
    })
    .returning({ id: companies.id });
  return row!.id;
}

async function insertAgentIfNotExists(data: {
  companyId: string;
  name: string;
  role: string;
  title: string;
  capabilities: string;
  reportsTo?: string | null;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
}): Promise<string> {
  const existing = await rawSql<{ id: string }[]>`
    SELECT id FROM agents
    WHERE company_id = ${data.companyId} AND name = ${data.name}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return existing[0]!.id;
  }

  const [row] = await db
    .insert(agents)
    .values({
      companyId: data.companyId,
      name: data.name,
      role: data.role,
      title: data.title,
      capabilities: data.capabilities,
      reportsTo: data.reportsTo ?? null,
      adapterType: data.adapterType ?? "claude_local",
      adapterConfig: data.adapterConfig ?? {},
      status: "idle",
    })
    .returning({ id: agents.id });
  return row!.id;
}

// Budget limits per C-suite role (cents/month)
const CSUITE_BUDGETS: Record<string, number> = {
  ceo: 200_00,  // $200
  cto: 150_00,  // $150
  cfo: 100_00,  // $100
  coo: 100_00,  // $100
  cmo:  75_00,  //  $75
};
const EVOHAUS_CSUITE_BUDGET = 500_00; // $500 for holding C-suite

async function upsertAgentBudgetPolicy(
  companyId: string,
  agentId: string,
  amountCents: number,
): Promise<void> {
  await db
    .insert(budgetPolicies)
    .values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: amountCents,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    })
    .onConflictDoNothing();
}

async function createCsuite(companyId: string, companyName: string, isHolding = false): Promise<void> {
  let ceoId: string | null = null;
  for (const exec of C_SUITE) {
    const name = `${companyName} ${exec.suffix}`;
    const id = await insertAgentIfNotExists({
      companyId,
      name,
      role: exec.role,
      title: exec.title,
      capabilities: exec.capabilities,
      reportsTo: exec.role === "ceo" ? null : ceoId,
      adapterType: "claude_local",
      adapterConfig: {},
    });
    if (exec.role === "ceo") ceoId = id;
    const budget = isHolding ? EVOHAUS_CSUITE_BUDGET : (CSUITE_BUDGETS[exec.role] ?? 100_00);
    await upsertAgentBudgetPolicy(companyId, id, budget);
    console.log(`    [OK] ${name} (budget: $${budget / 100}/mo)`);
  }
}

async function migrateProjectToCompany(
  projectSlug: string,
  newCompanyId: string,
): Promise<void> {
  // Find project by metadata slug in the EvoHaus company
  const projectRows = await rawSql<{ id: string; name: string }[]>`
    SELECT id, name FROM projects
    WHERE company_id = ${EVOHAUS_ID}
      AND archived_at IS NULL
      AND (
        name ILIKE ${`%${projectSlug.replace(/-/g, "%")}%`}
        OR EXISTS (
          SELECT 1 FROM agents a
          WHERE a.company_id = ${EVOHAUS_ID}
            AND a.metadata->>'project' = ${projectSlug}
        )
      )
    LIMIT 1
  `;

  if (projectRows.length === 0) {
    console.log(`  [WARN] No active project found for slug: ${projectSlug}`);
    return;
  }

  const projectId = projectRows[0]!.id;
  const projectName = projectRows[0]!.name;

  // Move project to new company
  await rawSql`
    UPDATE projects SET company_id = ${newCompanyId} WHERE id = ${projectId}
  `;

  // Move project workspaces
  await rawSql`
    UPDATE project_workspaces SET company_id = ${newCompanyId} WHERE project_id = ${projectId}
  `;

  // Move execution workspaces
  await rawSql`
    UPDATE execution_workspaces SET company_id = ${newCompanyId} WHERE project_id = ${projectId}
  `;

  // Move issues
  await rawSql`
    UPDATE issues SET company_id = ${newCompanyId} WHERE project_id = ${projectId}
  `;

  // Move agents belonging to this project (by metadata.project slug)
  await rawSql`
    UPDATE agents
    SET company_id = ${newCompanyId}
    WHERE company_id = ${EVOHAUS_ID}
      AND metadata->>'project' = ${projectSlug}
  `;

  console.log(`  [OK] Moved "${projectName}" (${projectId}) → company ${newCompanyId}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("EvoHaus Holding Migration — Started\n");

  // =========================================================================
  // Step 1: Update EvoHaus issuePrefix to EVO (if available)
  // =========================================================================
  console.log("Step 1: Checking EvoHaus issuePrefix...");
  const evoCurrent = await rawSql<{ issue_prefix: string }[]>`
    SELECT issue_prefix FROM companies WHERE id = ${EVOHAUS_ID}
  `;
  const currentPrefix = evoCurrent[0]?.issue_prefix;
  if (currentPrefix === "EVO") {
    console.log("  [OK] EvoHaus issuePrefix already = EVO\n");
  } else {
    // Check if EVO is taken by another non-archived company
    const evoConflict = await rawSql<{ id: string }[]>`
      SELECT id FROM companies
      WHERE issue_prefix = 'EVO' AND id != ${EVOHAUS_ID} AND status != 'archived'
    `;
    if (evoConflict.length > 0) {
      console.log(`  [SKIP] EVO prefix taken by another active company, keeping current prefix: ${currentPrefix}\n`);
    } else {
      // Reassign archived company's prefix first if needed
      await rawSql`
        UPDATE companies SET issue_prefix = 'EVO_ARCHIVED'
        WHERE issue_prefix = 'EVO' AND status = 'archived'
      `;
      await rawSql`
        UPDATE companies SET issue_prefix = 'EVO'
        WHERE id = ${EVOHAUS_ID}
      `;
      console.log("  [OK] EvoHaus issuePrefix = EVO\n");
    }
  }

  // =========================================================================
  // Step 2: Add EvoHaus C-suite (CFO + CMO are missing from seed)
  // =========================================================================
  console.log("Step 2: Ensuring EvoHaus C-suite...");
  // Find existing CEO
  const evoCeo = await rawSql<{ id: string }[]>`
    SELECT id FROM agents
    WHERE company_id = ${EVOHAUS_ID} AND role = 'ceo'
    LIMIT 1
  `;
  const evoCeoId = evoCeo.length > 0 ? evoCeo[0]!.id : null;

  if (!evoCeoId) {
    console.log("  [WARN] EvoHaus CEO not found, skipping C-suite additions");
  } else {
    for (const exec of C_SUITE) {
      if (exec.role === "ceo") continue; // Already exists (EVO)
      const name = `EvoHaus ${exec.suffix}`;
      const agentId = await insertAgentIfNotExists({
        companyId: EVOHAUS_ID,
        name,
        role: exec.role,
        title: exec.title,
        capabilities: exec.capabilities,
        reportsTo: evoCeoId,
      });
      await upsertAgentBudgetPolicy(EVOHAUS_ID, agentId, EVOHAUS_CSUITE_BUDGET);
      console.log(`  [OK] ${name} (budget: $${EVOHAUS_CSUITE_BUDGET / 100}/mo)`);
    }
  }
  console.log();

  // =========================================================================
  // Step 3: Create subsidiary companies + migrate projects + create C-suites
  // =========================================================================
  console.log("Step 3: Creating subsidiary companies...\n");

  for (const sub of SUBSIDIARIES) {
    console.log(`  Creating: ${sub.name} (${sub.issuePrefix})...`);

    // Create company
    const companyId = await upsertCompany({
      name: sub.name,
      issuePrefix: sub.issuePrefix,
      description: sub.description,
      brandColor: sub.brandColor,
      parentCompanyId: EVOHAUS_ID,
    });

    // Migrate project + agents + issues
    await migrateProjectToCompany(sub.slug, companyId);

    // Create C-suite for subsidiary
    console.log(`  Creating C-suite for ${sub.name}...`);
    await createCsuite(companyId, sub.name, false);

    console.log();
  }

  // =========================================================================
  // Step 4: Summary
  // =========================================================================
  const companyCount = await rawSql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM companies WHERE status != 'archived'
  `;
  const subsidiaryCount = await rawSql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM companies
    WHERE parent_company_id = ${EVOHAUS_ID}
  `;

  console.log("=".repeat(60));
  console.log("Migration Complete!");
  console.log(`  Total active companies: ${companyCount[0]?.count}`);
  console.log(`  EvoHaus subsidiaries: ${subsidiaryCount[0]?.count}`);
  console.log("=".repeat(60));

  await rawSql.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
