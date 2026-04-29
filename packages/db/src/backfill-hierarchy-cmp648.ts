/**
 * One-off backfill for the hierarchy / review-QA fields added in migration 0075
 * (CMP-647 design, CMP-648 implementation).
 *
 * Updates the canonical 9 company agents with orgLevel, primaryWorkflowRole,
 * specialty, defaultReviewAgentId, and defaultQaAgentId per the CTO design table.
 *
 * Does NOT change `reportsTo`. The 윤광고 / 윤유튜브 reportsTo move from 윤CTO to
 * 윤CMO is held until 윤CEO posts an ack on CMP-647 — handled in a follow-up run.
 *
 * Run with:
 *   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:54329/paperclip \
 *     pnpm --filter @paperclipai/db exec tsx src/backfill-hierarchy-cmp648.ts
 */
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { agents } from "./schema/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

const AGENT_ID = {
  ceo: "a67e720c-624b-4d8e-bd7b-ff9e953cae93",
  cto: "9d4405ad-175c-427d-ac5a-7fbe474875a4",
  cmo: "1a6ef27a-3e76-4d7d-a392-40bcfae6f733",
  techOps: "0afe0c6e-fd39-49fd-8c62-c8fe32a28a0f",
  ads: "2d95dd48-3967-4f18-acc5-d0b74194944f",
  youtube: "5bd3c49b-edf5-46a4-b707-3183f0c86c76",
  secretary: "3e6fb76c-a79c-498c-80ce-b4de740f8b56",
  qa: "78cdccf5-5532-44bd-98a1-cf6980391f84",
  opsPolicy: "b3d9c226-6d8c-4dba-a432-d3a523e9fa07",
} as const;

interface BackfillRow {
  name: string;
  id: string;
  orgLevel: "executor" | "manager" | "executive" | "qa" | "policy" | "pm";
  primaryWorkflowRole: "execution" | "review" | "qa" | "approval" | "policy";
  specialty: string;
  defaultReviewAgentId: string | null;
  defaultQaAgentId: string | null;
}

const ROWS: BackfillRow[] = [
  {
    name: "윤CEO",
    id: AGENT_ID.ceo,
    orgLevel: "executive",
    primaryWorkflowRole: "approval",
    specialty: "leadership",
    defaultReviewAgentId: null,
    defaultQaAgentId: null,
  },
  {
    name: "윤CTO",
    id: AGENT_ID.cto,
    orgLevel: "manager",
    primaryWorkflowRole: "review",
    specialty: "tech",
    defaultReviewAgentId: AGENT_ID.ceo,
    defaultQaAgentId: AGENT_ID.qa,
  },
  {
    name: "윤CMO",
    id: AGENT_ID.cmo,
    orgLevel: "manager",
    primaryWorkflowRole: "review",
    specialty: "marketing",
    defaultReviewAgentId: AGENT_ID.ceo,
    defaultQaAgentId: AGENT_ID.qa,
  },
  {
    name: "윤기술운영",
    id: AGENT_ID.techOps,
    orgLevel: "executor",
    primaryWorkflowRole: "execution",
    specialty: "tech_ops",
    defaultReviewAgentId: AGENT_ID.cto,
    defaultQaAgentId: AGENT_ID.qa,
  },
  {
    name: "윤광고",
    id: AGENT_ID.ads,
    orgLevel: "executor",
    primaryWorkflowRole: "execution",
    specialty: "ads",
    defaultReviewAgentId: AGENT_ID.cmo,
    defaultQaAgentId: AGENT_ID.opsPolicy,
  },
  {
    name: "윤유튜브",
    id: AGENT_ID.youtube,
    orgLevel: "executor",
    primaryWorkflowRole: "execution",
    specialty: "youtube",
    defaultReviewAgentId: AGENT_ID.cmo,
    defaultQaAgentId: AGENT_ID.qa,
  },
  {
    name: "윤비서",
    id: AGENT_ID.secretary,
    orgLevel: "pm",
    primaryWorkflowRole: "execution",
    specialty: "schedule",
    defaultReviewAgentId: AGENT_ID.cto,
    defaultQaAgentId: AGENT_ID.qa,
  },
  {
    name: "윤QA",
    id: AGENT_ID.qa,
    orgLevel: "qa",
    primaryWorkflowRole: "qa",
    specialty: "qa_software",
    defaultReviewAgentId: AGENT_ID.cto,
    defaultQaAgentId: null,
  },
  {
    name: "윤운영기준",
    id: AGENT_ID.opsPolicy,
    orgLevel: "policy",
    primaryWorkflowRole: "policy",
    specialty: "ops_policy",
    defaultReviewAgentId: AGENT_ID.cto,
    defaultQaAgentId: null,
  },
];

let updated = 0;
let missing = 0;
for (const row of ROWS) {
  const result = await db
    .update(agents)
    .set({
      orgLevel: row.orgLevel,
      primaryWorkflowRole: row.primaryWorkflowRole,
      specialty: row.specialty,
      defaultReviewAgentId: row.defaultReviewAgentId,
      defaultQaAgentId: row.defaultQaAgentId,
    })
    .where(eq(agents.id, row.id))
    .returning({ id: agents.id, name: agents.name });

  if (result.length === 0) {
    console.warn(`  - SKIP ${row.name} (${row.id}): agent not found`);
    missing += 1;
    continue;
  }
  console.log(`  - OK   ${row.name} (${row.id})`);
  updated += 1;
}

console.log(`\nBackfill complete: ${updated} updated, ${missing} missing.`);
console.log("Note: 윤광고 / 윤유튜브 reportsTo unchanged — pending 윤CEO ack on CMP-647.");
