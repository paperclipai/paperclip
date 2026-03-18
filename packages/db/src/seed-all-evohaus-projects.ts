/**
 * EVOHAUS AI — Full Organization Seed Script
 *
 * Seeds the complete EVOHAUS AI holding company:
 *   - 1 company (upsert)
 *   - 1 CEO + 3 C-Level + 11 operational agents
 *   - 15 projects, each with a lead agent + team agents + workspaces
 *
 * Run: npx tsx packages/db/src/seed-all-evohaus-projects.ts
 */

import { createDb } from "./client.js";
import {
  companies,
  agents,
  projects,
  projectWorkspaces,
} from "./schema/index.js";
import { eq } from "drizzle-orm";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const COMPANY_ID = "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertAgent(data: typeof agents.$inferInsert): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values(data)
    .returning({ id: agents.id });
  return row!.id;
}

async function insertProject(data: typeof projects.$inferInsert): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values(data)
    .returning({ id: projects.id });
  return row!.id;
}

async function insertWorkspace(data: typeof projectWorkspaces.$inferInsert): Promise<void> {
  await db.insert(projectWorkspaces).values(data);
}

interface TeamMemberDef {
  name: string;
  role: string;
  title: string;
  capabilities: string;
}

interface WorkspaceDef {
  name: string;
  cwd: string;
  isPrimary: boolean;
}

interface ProjectDef {
  slug: string;
  name: string;
  color: string;
  status: string;
  description: string;
  lead: {
    name: string;
    openclawAgentId: string;
    capabilities: string;
  };
  team: TeamMemberDef[];
  workspaces: WorkspaceDef[];
}

async function seedProject(def: ProjectDef, ceoId: string): Promise<void> {
  // Lead agent
  const leadId = await insertAgent({
    companyId: COMPANY_ID,
    name: def.lead.name,
    role: "project_lead",
    title: "Project Lead",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: def.lead.openclawAgentId },
    capabilities: def.lead.capabilities,
    reportsTo: ceoId,
    metadata: { level: "project_lead", project: def.slug, heartbeat: "24h" },
  });

  // Team agents
  for (const member of def.team) {
    await insertAgent({
      companyId: COMPANY_ID,
      name: member.name,
      role: member.role,
      title: member.title,
      adapterType: "claude_local",
      adapterConfig: {},
      capabilities: member.capabilities,
      reportsTo: leadId,
      metadata: { level: "team", project: def.slug },
    });
  }

  // Project
  const projectId = await insertProject({
    companyId: COMPANY_ID,
    name: def.name,
    description: def.description,
    status: def.status,
    color: def.color,
    leadAgentId: leadId,
  });

  // Workspaces
  for (const ws of def.workspaces) {
    await insertWorkspace({
      companyId: COMPANY_ID,
      projectId,
      name: ws.name,
      sourceType: "local_path",
      cwd: ws.cwd,
      isPrimary: ws.isPrimary,
    });
  }

  console.log(`  [OK] ${def.name} — lead + ${def.team.length} team + ${def.workspaces.length} workspaces`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("EVOHAUS AI — Seeding started\n");

  // =========================================================================
  // 0. Clean existing data (order matters for FK constraints)
  // =========================================================================
  console.log("Cleaning existing data...");
  // Use raw SQL to clean FK-dependent tables for this company's agents
  const rawSql = postgres(url);
  await rawSql`DELETE FROM project_workspaces WHERE company_id = ${COMPANY_ID}`;
  await rawSql`DELETE FROM projects WHERE company_id = ${COMPANY_ID}`;
  // Disable FK checks temporarily, delete all company data, re-enable
  await rawSql.unsafe(`SET session_replication_role = 'replica'`);
  await rawSql.unsafe(`DELETE FROM project_workspaces WHERE company_id = '${COMPANY_ID}'`);
  await rawSql.unsafe(`DELETE FROM projects WHERE company_id = '${COMPANY_ID}'`);
  await rawSql.unsafe(`DELETE FROM agents WHERE company_id = '${COMPANY_ID}'`);
  await rawSql.unsafe(`SET session_replication_role = 'origin'`);
  await rawSql.end();
  console.log("  [OK] Cleaned\n");

  // =========================================================================
  // 1. Upsert company
  // =========================================================================
  console.log("Upserting company...");
  await db
    .insert(companies)
    .values({
      id: COMPANY_ID,
      name: "EVOHAUS AI",
      description: "14 projeli teknoloji holding — AI-native otonom organizasyon",
      status: "active",
      budgetMonthlyCents: 100000,
    })
    .onConflictDoUpdate({
      target: companies.id,
      set: {
        name: "EVOHAUS AI",
        description: "14 projeli teknoloji holding — AI-native otonom organizasyon",
        budgetMonthlyCents: 100000,
      },
    });
  console.log("  [OK] EVOHAUS AI\n");

  // =========================================================================
  // 2. CEO
  // =========================================================================
  console.log("Creating CEO...");
  const ceoId = await insertAgent({
    companyId: COMPANY_ID,
    name: "EVO",
    role: "ceo",
    title: "Chief Executive Officer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "main", model: "anthropic/claude-opus-4-6" },
    capabilities: "strategic-planning, delegation, org-management, reporting",
    metadata: { level: "c-level", heartbeat: "2h" },
  });
  console.log(`  [OK] EVO (${ceoId})\n`);

  // =========================================================================
  // 3. C-Level agents
  // =========================================================================
  console.log("Creating C-Level agents...");

  const cooId = await insertAgent({
    companyId: COMPANY_ID,
    name: "OPERASYON",
    role: "coo",
    title: "Chief Operating Officer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "atlas-coo", model: "anthropic/claude-sonnet-4-6" },
    capabilities: "operations, scraper-management, vps-monitoring, whatsapp, crm",
    reportsTo: ceoId,
    metadata: { level: "c-level", heartbeat: "2h" },
  });
  console.log(`  [OK] OPERASYON (${cooId})`);

  const ctoId = await insertAgent({
    companyId: COMPANY_ID,
    name: "TEKNIK",
    role: "cto",
    title: "Chief Technology Officer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "forge-cto", model: "anthropic/claude-sonnet-4-6" },
    capabilities: "architecture, deployment, security, research, database",
    reportsTo: ceoId,
    metadata: { level: "c-level", heartbeat: "3h" },
  });
  console.log(`  [OK] TEKNIK (${ctoId})`);

  const cgoId = await insertAgent({
    companyId: COMPANY_ID,
    name: "PAZARLAMA",
    role: "cgo",
    title: "Chief Growth Officer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "hunter-cgo", model: "anthropic/claude-sonnet-4-6" },
    capabilities: "marketing, outreach, email, intelligence",
    reportsTo: ceoId,
    metadata: { level: "c-level", heartbeat: "4h" },
  });
  console.log(`  [OK] PAZARLAMA (${cgoId})\n`);

  // =========================================================================
  // 4. Operational agents
  // =========================================================================
  console.log("Creating operational agents...");

  // --- Reports to COO ---
  await insertAgent({
    companyId: COMPANY_ID,
    name: "SCRAPER-TAKIP",
    role: "ops_scraper",
    title: "Scraper Operations",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "pulse-scraper" },
    capabilities: "scraper-monitoring, data-collection",
    reportsTo: cooId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] SCRAPER-TAKIP");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "SUNUCU",
    role: "ops_vps",
    title: "Server Operations",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "sentry-vps" },
    capabilities: "vps-monitoring, docker, system-health",
    reportsTo: cooId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] SUNUCU");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "WHATSAPP",
    role: "ops_messaging",
    title: "WhatsApp Operations",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "bridge-whatsapp" },
    capabilities: "whatsapp-management, messaging",
    reportsTo: cooId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] WHATSAPP");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "CRM",
    role: "ops_crm",
    title: "CRM Operations",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "clerk-crm" },
    capabilities: "crm, customer-tracking",
    reportsTo: cooId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] CRM");

  // --- Reports to CTO ---
  await insertAgent({
    companyId: COMPANY_ID,
    name: "DEPLOY",
    role: "eng_deploy",
    title: "Deploy Engineer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "welder-deploy" },
    capabilities: "ci-cd, docker-deploy, infrastructure",
    reportsTo: ctoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] DEPLOY");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "GUVENLIK",
    role: "eng_security",
    title: "Security Engineer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "shield-security" },
    capabilities: "security-audit, vulnerability-scanning",
    reportsTo: ctoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] GUVENLIK");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "ARASTIRMA",
    role: "eng_research",
    title: "Research Engineer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "scout-research" },
    capabilities: "technology-research, evaluation",
    reportsTo: ctoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] ARASTIRMA");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "VERITABANI",
    role: "eng_database",
    title: "Database Engineer",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "dock-database" },
    capabilities: "database-management, optimization, migrations",
    reportsTo: ctoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] VERITABANI");

  // --- Reports to CGO ---
  await insertAgent({
    companyId: COMPANY_ID,
    name: "REKLAM",
    role: "mkt_outreach",
    title: "Outreach Specialist",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "ghost-outreach" },
    capabilities: "outreach, advertising, lead-generation",
    reportsTo: cgoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] REKLAM");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "EMAIL",
    role: "mkt_email",
    title: "Email Marketing",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "herald-email" },
    capabilities: "email-campaigns, newsletters",
    reportsTo: cgoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] EMAIL");

  await insertAgent({
    companyId: COMPANY_ID,
    name: "ISTIHBARAT",
    role: "mkt_intel",
    title: "Market Intelligence",
    adapterType: "openclaw-gateway",
    adapterConfig: { openclawAgentId: "radar-intel" },
    capabilities: "market-research, competitor-analysis",
    reportsTo: cgoId,
    metadata: { level: "operational" },
  });
  console.log("  [OK] ISTIHBARAT\n");

  // =========================================================================
  // 5. Projects (14 total)
  // =========================================================================
  console.log("Creating projects...\n");

  // -----------------------------------------------------------------------
  // PROJECT 1: MersinSteel MaliPanel
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "mersin-steel",
      name: "MersinSteel MaliPanel",
      color: "#3b82f6",
      status: "in_progress",
      description: "Celik sektoru muhasebe ve mali yonetim paneli",
      lead: {
        name: "MersinSteel Lead",
        openclawAgentId: "prj-mersin-steel",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "MersinSteel PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "MersinSteel Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "MersinSteel Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "MersinSteel Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "MersinSteel Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "MersinSteel Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "MersinSteel Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer" },
        { name: "MersinSteel DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "MersinSteel QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "MersinSteel Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "MersinSteel Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "MersinSteel Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "MersinSteel Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/Muhittin Muhasebe", isPrimary: true },
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/MersinSteel-iOS", isPrimary: false },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 2: Navico Fleet Management
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "navico",
      name: "Navico Fleet Management",
      color: "#10b981",
      status: "in_progress",
      description: "Lojistik filo yonetim ve arac takip sistemi",
      lead: {
        name: "Navico Lead",
        openclawAgentId: "prj-navico",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "Navico PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Navico Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "Navico Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "Navico Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "Navico Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "Navico Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "Navico Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer" },
        { name: "Navico DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "Navico QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "Navico Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "Navico Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "Navico Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "Navico Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/navico", isPrimary: true },
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/Navico-iOS", isPrimary: false },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 3: Emir GTIP
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "emir",
      name: "Emir GTIP",
      color: "#f59e0b",
      status: "in_progress",
      description: "Gumruk tarife ve GTIP yonetim sistemi",
      lead: {
        name: "Emir Lead",
        openclawAgentId: "prj-emir",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "Emir PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Emir Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "Emir Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "Emir Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "Emir Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "Emir Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database, fastapi-pro" },
        { name: "Emir Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer" },
        { name: "Emir DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "Emir QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "Emir Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "Emir Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "Emir Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "Emir Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/Emir", isPrimary: true },
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/Emir-iOS", isPrimary: false },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 4: KsAtlas Muhasebe
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "ksatlas",
      name: "KsAtlas Muhasebe",
      color: "#6366f1",
      status: "in_progress",
      description: "Dis ticaret muhasebe ve kur takip sistemi",
      lead: {
        name: "KsAtlas Lead",
        openclawAgentId: "prj-ksatlas",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "KsAtlas PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "KsAtlas Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "KsAtlas Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "KsAtlas Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "KsAtlas Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "KsAtlas Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "KsAtlas DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "KsAtlas QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "KsAtlas Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "KsAtlas Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "KsAtlas Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "KsAtlas Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/KsAtlas Muhasebe", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 5: Celal Isinlik
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "celal-isinlik",
      name: "Celal Isinlik",
      color: "#84cc16",
      status: "in_progress",
      description: "Imalat sektoru uretim takip ve is emri yonetimi",
      lead: {
        name: "Celal Lead",
        openclawAgentId: "prj-celal",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "Celal PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Celal Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "Celal Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "Celal Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "Celal Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "Celal Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "Celal Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer" },
        { name: "Celal DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "Celal QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "Celal Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "Celal Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "Celal Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "Celal Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/Celal Isinlik Dashboard", isPrimary: true },
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/CelalIsinlik-iOS", isPrimary: false },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 6: HukukBank
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "hukukbank",
      name: "HukukBank",
      color: "#8b5cf6",
      status: "in_progress",
      description: "Yargitay kararlari arama ve analiz platformu",
      lead: {
        name: "HukukBank Lead",
        openclawAgentId: "prj-hukukbank",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "HukukBank PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "HukukBank Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "HukukBank Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "HukukBank Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "HukukBank Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "HukukBank Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "HukukBank DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "HukukBank QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "HukukBank Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "HukukBank Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "HukukBank Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "HukukBank Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/YargitayKararlari", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 7: EkstreAI
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "ekstrai",
      name: "EkstreAI",
      color: "#06b6d4",
      status: "in_progress",
      description: "Banka ekstresi OCR ve otomatik ayristirma",
      lead: {
        name: "EkstreAI Lead",
        openclawAgentId: "prj-ekstrai",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "EkstreAI PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "EkstreAI Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "EkstreAI Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "EkstreAI Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "EkstreAI Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "EkstreAI Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "EkstreAI DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "EkstreAI QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "EkstreAI Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "EkstreAI Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "EkstreAI Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "EkstreAI Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/EkstreAI", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 8: PsikoRuya
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "psikoruya",
      name: "PsikoRuya",
      color: "#ec4899",
      status: "in_progress",
      description: "B2C ruya analizi ve wellness mobil uygulamasi",
      lead: {
        name: "PsikoRuya Lead",
        openclawAgentId: "prj-psikoruya",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "PsikoRuya PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "PsikoRuya Growth", role: "growth", title: "Growth", capabilities: "growth-hacker, onboarding-cro, analytics-product" },
        { name: "PsikoRuya Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "PsikoRuya Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "PsikoRuya Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "PsikoRuya Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "PsikoRuya Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer" },
        { name: "PsikoRuya QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "PsikoRuya Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "PsikoRuya Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "PsikoRuya ASO", role: "aso", title: "ASO Specialist", capabilities: "aso-optimization, app-store-marketing, mobile-growth" },
      ],
      workspaces: [
        { name: "mobile", cwd: "/Users/evohaus/Desktop/Projects/PsikoRuya", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 9: Transaktas
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "transaktas",
      name: "Transaktas",
      color: "#14b8a6",
      status: "in_progress",
      description: "Nakliye ve kargo takip sistemi",
      lead: {
        name: "Transaktas Lead",
        openclawAgentId: "prj-transaktas",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "Transaktas PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Transaktas Sales", role: "sales", title: "Sales", capabilities: "sales-automator, pricing-strategy, startup-analyst" },
        { name: "Transaktas Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "Transaktas Lead Eng", role: "lead_engineer", title: "Lead Engineer", capabilities: "senior-fullstack, architect-review, code-review, architecture" },
        { name: "Transaktas Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "Transaktas Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "Transaktas Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer" },
        { name: "Transaktas DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "Transaktas QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "Transaktas Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "Transaktas Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "Transaktas Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "Transaktas Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/Transaktas", isPrimary: true },
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/Transaktas - IOS", isPrimary: false },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 10: Vito
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "vito",
      name: "Vito",
      color: "#1e293b",
      status: "in_progress",
      description: "B2C luks otomotiv Bluetooth baglanti iOS uygulamasi",
      lead: {
        name: "Vito Lead",
        openclawAgentId: "prj-vito",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "Vito PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Vito Growth", role: "growth", title: "Growth", capabilities: "growth-hacker, onboarding-cro, analytics-product" },
        { name: "Vito Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "Vito Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer, bluetooth-le" },
        { name: "Vito QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "Vito Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "Vito Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "Vito Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "Vito ASO", role: "aso", title: "ASO Specialist", capabilities: "aso-optimization, app-store-marketing, mobile-growth" },
      ],
      workspaces: [
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/Vito", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 11: Mission Control
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "mission-control",
      name: "Mission Control",
      color: "#f97316",
      status: "in_progress",
      description: "Internal DevOps kontrol paneli ve agent yonetimi",
      lead: {
        name: "MissionCtrl Lead",
        openclawAgentId: "prj-mission-control",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "MissionCtrl PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "MissionCtrl Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "MissionCtrl Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "MissionCtrl DevOps", role: "devops", title: "DevOps Engineer", capabilities: "docker-expert, vps-docker-deploy, deploy, cloud-devops" },
        { name: "MissionCtrl QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "MissionCtrl Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "MissionCtrl Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/control.evohaus", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 12: Vitalix
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "vitalix",
      name: "Vitalix",
      color: "#22c55e",
      status: "in_progress",
      description: "B2C saglik takip ve HealthKit iOS uygulamasi",
      lead: {
        name: "Vitalix Lead",
        openclawAgentId: "prj-vitalix",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "Vitalix PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Vitalix Growth", role: "growth", title: "Growth", capabilities: "growth-hacker, onboarding-cro, analytics-product" },
        { name: "Vitalix Marketing", role: "marketing", title: "Marketing", capabilities: "content-marketer, seo-fundamentals, copywriting, social-content" },
        { name: "Vitalix Mobile", role: "mobile_engineer", title: "Mobile Engineer", capabilities: "ios-developer, swiftui-expert-skill, mobile-developer, healthkit" },
        { name: "Vitalix Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "Vitalix QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, e2e-testing, generate-tests, find-bugs" },
        { name: "Vitalix Designer", role: "designer", title: "Designer", capabilities: "ui-ux-designer, frontend-design, design, tailwind-patterns" },
        { name: "Vitalix Support", role: "customer_success", title: "Customer Success", capabilities: "customer-support, helpdesk-automation, onboarding-cro" },
        { name: "Vitalix Analyst", role: "data_analyst", title: "Data Analyst", capabilities: "data-scientist, database-optimizer, analytics-product" },
        { name: "Vitalix ASO", role: "aso", title: "ASO Specialist", capabilities: "aso-optimization, app-store-marketing, mobile-growth" },
      ],
      workspaces: [
        { name: "ios", cwd: "/Users/evohaus/Desktop/Projects/Vitalix-iOS", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 13: Kosgeb
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "kosgeb",
      name: "Kosgeb",
      color: "#a855f7",
      status: "in_progress",
      description: "KOSGEB hibe basvuru ve dokuman yonetimi",
      lead: {
        name: "Kosgeb Lead",
        openclawAgentId: "prj-kosgeb",
        capabilities: "product-manager, plan-writing, code-review",
      },
      team: [
        { name: "Kosgeb PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "Kosgeb Content", role: "content", title: "Content Writer", capabilities: "content-marketer, copywriting, technical-writing" },
        { name: "Kosgeb Research", role: "research", title: "Researcher", capabilities: "technology-research, evaluation, market-research" },
        { name: "Kosgeb Finance", role: "finance", title: "Finance Planner", capabilities: "financial-planning, budgeting, reporting" },
      ],
      workspaces: [
        { name: "docs", cwd: "/Users/evohaus/Desktop/Projects/Kosgeb", isPrimary: true },
      ],
    },
    ceoId,
  );

  // -----------------------------------------------------------------------
  // PROJECT 14: Private Bank
  // -----------------------------------------------------------------------
  await seedProject(
    {
      slug: "private-bank",
      name: "Private Bank",
      color: "#0ea5e9",
      status: "in_progress",
      description: "Ozel bankacilik dashboard ve finans yonetimi",
      lead: {
        name: "PrivateBank Lead",
        openclawAgentId: "prj-private-bank",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "PrivateBank PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, create-prd, product-manager-toolkit" },
        { name: "PrivateBank Frontend", role: "frontend_engineer", title: "Frontend Engineer", capabilities: "frontend-developer, react-best-practices, nextjs-best-practices, tailwind-patterns" },
        { name: "PrivateBank Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, database" },
        { name: "PrivateBank Security", role: "security", title: "Security Engineer", capabilities: "security-audit, security, api-security-best-practices" },
      ],
      workspaces: [
        { name: "web", cwd: "/Users/evohaus/Desktop/Projects/Private bank", isPrimary: true },
      ],
    },
    ceoId,
  );

  // PROJECT 15: Skill Scout
  await seedProject(
    {
      slug: "skill-scout",
      name: "Skill Scout",
      color: "#f43f5e",
      status: "in_progress",
      description: "OpenClaw skill kesfetme, filtreleme ve kurasyon platformu — ClawHub ekosisteminden otomatik kaliteli skill discovery",
      lead: {
        name: "SkillScout Lead",
        openclawAgentId: "skill-scout",
        capabilities: "product-manager, architecture, plan-writing, code-review",
      },
      team: [
        { name: "SkillScout Backend", role: "backend_engineer", title: "Backend Engineer", capabilities: "backend-dev-guidelines, nodejs-best-practices, api-design-principles, web-scraper" },
        { name: "SkillScout QA", role: "qa_engineer", title: "QA Engineer", capabilities: "test-driven-development, find-bugs, security-audit, code-review" },
        { name: "SkillScout PM", role: "product_manager", title: "Product Manager", capabilities: "product-manager, data-analyst, analytics-product" },
      ],
      workspaces: [
        { name: "agent", cwd: "/Users/evohaus/.openclaw/agents/skill-scout", isPrimary: true },
      ],
    },
    ceoId,
  );

  // =========================================================================
  // Done
  // =========================================================================
  console.log("\nSeed complete: 15 projects, ~165 agents");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
