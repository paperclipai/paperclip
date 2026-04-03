import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { knowledgePages, knowledgePageRevisions } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Workspace Templates ─────────────────────────────────────────────────────
//
// Each role gets a set of workspace folders created as knowledge_pages with
// document_type = "folder". Slugs follow the pattern: agent-{agentId}-{folder}.

interface WorkspaceTemplate {
  folders: string[];
  descriptions: Record<string, string>;
}

const WORKSPACE_TEMPLATES: Record<string, WorkspaceTemplate> = {
  ceo: {
    folders: ["strategy", "board-decisions", "company-direction"],
    descriptions: {
      strategy: "Strategic plans, vision documents, and OKRs.",
      "board-decisions": "Board-level decisions and rationale.",
      "company-direction": "Quarterly direction docs and pivots.",
    },
  },
  cto: {
    folders: ["architecture", "technical-debt", "engineering-standards"],
    descriptions: {
      architecture: "System architecture docs and ADRs.",
      "technical-debt": "Tech debt inventory and paydown plans.",
      "engineering-standards": "Coding standards and review guidelines.",
    },
  },
  cfo: {
    folders: ["financial-reports", "budget-analysis", "cost-optimization"],
    descriptions: {
      "financial-reports": "Monthly and quarterly financial reports.",
      "budget-analysis": "Budget proposals and variance analysis.",
      "cost-optimization": "Cost reduction recommendations.",
    },
  },
  cmo: {
    folders: ["campaigns", "brand-guidelines", "content-strategy"],
    descriptions: {
      campaigns: "Campaign briefs and results.",
      "brand-guidelines": "Brand voice and visual identity.",
      "content-strategy": "Content calendar and channel strategy.",
    },
  },
  vp_hr: {
    folders: ["personnel", "hiring-plans", "org-proposals"],
    descriptions: {
      personnel: "Personnel files and employee records.",
      "hiring-plans": "Headcount planning and role descriptions.",
      "org-proposals": "Organizational restructure proposals.",
    },
  },
  compliance: {
    folders: ["audit-logs", "compliance-checklists", "incident-response"],
    descriptions: {
      "audit-logs": "Audit findings and reports.",
      "compliance-checklists": "Regulation-specific checklists.",
      "incident-response": "Incident reports and post-mortems.",
    },
  },
  engineer: {
    folders: ["project-notes", "code-reviews", "retrospectives"],
    descriptions: {
      "project-notes": "Per-project technical notes.",
      "code-reviews": "Review notes and feedback.",
      retrospectives: "Sprint and project retrospectives.",
    },
  },
  content: {
    folders: ["content-calendar", "published", "style-guide"],
    descriptions: {
      "content-calendar": "Publishing schedule and topics.",
      published: "Final published content copies.",
      "style-guide": "Writing style reference.",
    },
  },
};

const DEFAULT_TEMPLATE: WorkspaceTemplate = {
  folders: ["notes", "reports"],
  descriptions: {
    notes: "General notes and working documents.",
    reports: "Reports and summaries.",
  },
};

/**
 * Map a role string to a template key. Handles common role variations.
 */
function resolveTemplateKey(role: string): string {
  const normalized = role.toLowerCase().replace(/[\s_-]+/g, "_");

  if (normalized.includes("ceo") || normalized.includes("chief_executive")) return "ceo";
  if (normalized.includes("cto") || normalized.includes("chief_technology")) return "cto";
  if (normalized.includes("cfo") || normalized.includes("chief_financial")) return "cfo";
  if (normalized.includes("cmo") || normalized.includes("chief_marketing")) return "cmo";
  if (normalized.includes("vp") && normalized.includes("hr")) return "vp_hr";
  if (normalized.includes("hr") && (normalized.includes("vice") || normalized.includes("head"))) return "vp_hr";
  if (normalized.includes("compliance") || normalized.includes("audit")) return "compliance";
  if (normalized.includes("engineer") || normalized.includes("developer") || normalized.includes("devops")) return "engineer";
  if (normalized.includes("content") || normalized.includes("marketer") || normalized.includes("writer")) return "content";

  return "default";
}

function getTemplate(role: string): WorkspaceTemplate {
  const key = resolveTemplateKey(role);
  return WORKSPACE_TEMPLATES[key] ?? DEFAULT_TEMPLATE;
}

function makeSlug(agentId: string, folder: string): string {
  // Use first 8 chars of UUID for brevity
  const shortId = agentId.replace(/-/g, "").slice(0, 8);
  return `agent-${shortId}-${folder}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-create workspace folder pages when an agent is hired.
 * Each folder becomes a knowledge_page with document_type = "folder".
 */
export async function createAgentWorkspace(
  db: Db,
  agentId: string,
  companyId: string,
  role: string,
): Promise<void> {
  const template = getTemplate(role);

  for (const folder of template.folders) {
    const slug = makeSlug(agentId, folder);
    const title = folder
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    const description = template.descriptions[folder] ?? "";

    // Skip if this folder page already exists (idempotent)
    const [existing] = await db
      .select({ id: knowledgePages.id })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.companyId, companyId), eq(knowledgePages.slug, slug)))
      .limit(1);

    if (existing) continue;

    const body = `# ${title}\n\n${description}`;

    const [page] = await db
      .insert(knowledgePages)
      .values({
        companyId,
        slug,
        title,
        body,
        visibility: "private",
        agentId,
        documentType: "folder",
        autoGenerated: true,
        createdByUserId: "system",
        updatedByUserId: "system",
      })
      .returning();

    await db.insert(knowledgePageRevisions).values({
      pageId: page!.id,
      companyId,
      revisionNumber: 1,
      title,
      body,
      changeSummary: "Workspace folder created automatically",
      editedByUserId: "system",
    });
  }

  logger.info(
    { agentId, companyId, role, folders: template.folders.length },
    "agent workspace created",
  );
}

/**
 * Archive all knowledge pages owned by an agent.
 * Sets visibility to "archived" so they become read-only in the UI.
 */
export async function archiveAgentWorkspace(
  db: Db,
  agentId: string,
): Promise<void> {
  const now = new Date();

  await db
    .update(knowledgePages)
    .set({
      visibility: "archived",
      updatedAt: now,
      updatedByUserId: "system",
    })
    .where(
      and(
        eq(knowledgePages.agentId, agentId),
        // Don't re-archive already archived pages
        isNull(knowledgePages.agentId) ? undefined : eq(knowledgePages.agentId, agentId),
      ),
    );

  logger.info({ agentId }, "agent workspace archived");
}

/**
 * Create a document in an agent's workspace.
 * Returns the created page ID.
 */
export async function createAgentDocument(
  db: Db,
  opts: {
    agentId: string;
    companyId: string;
    title: string;
    content: string;
    documentType: string;
    slug: string;
    department?: string;
    visibility?: string;
    autoGenerated?: boolean;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
  },
): Promise<string> {
  const {
    agentId,
    companyId,
    title,
    content,
    documentType,
    slug,
    department,
    visibility = "private",
    autoGenerated = false,
    createdByAgentId,
    createdByUserId = "system",
  } = opts;

  // Ensure unique slug
  let finalSlug = slug;
  let suffix = 2;
  while (true) {
    const [existing] = await db
      .select({ id: knowledgePages.id })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.companyId, companyId), eq(knowledgePages.slug, finalSlug)))
      .limit(1);
    if (!existing) break;
    finalSlug = `${slug}-${suffix++}`;
  }

  const [page] = await db
    .insert(knowledgePages)
    .values({
      companyId,
      slug: finalSlug,
      title,
      body: content,
      visibility,
      agentId,
      documentType,
      autoGenerated,
      department: department ?? null,
      createdByAgentId: createdByAgentId ?? null,
      createdByUserId: createdByUserId ?? null,
      updatedByAgentId: createdByAgentId ?? null,
      updatedByUserId: createdByUserId ?? null,
    })
    .returning();

  await db.insert(knowledgePageRevisions).values({
    pageId: page!.id,
    companyId,
    revisionNumber: 1,
    title,
    body: content,
    changeSummary: autoGenerated ? "Auto-generated document" : "Created document",
    editedByAgentId: createdByAgentId ?? null,
    editedByUserId: createdByUserId ?? null,
  });

  return page!.id;
}

/**
 * Get all documents for an agent's workspace.
 */
export async function getAgentDocuments(
  db: Db,
  agentId: string,
) {
  return db
    .select()
    .from(knowledgePages)
    .where(eq(knowledgePages.agentId, agentId))
    .orderBy(knowledgePages.updatedAt);
}
