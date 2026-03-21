import { pathToFileURL } from "node:url";
import { createDb, type Db } from "./client.js";
import { companies, agents, goals, projects, issues, approvals } from "./schema/index.js";

export function createSampleLinkedInDraftApprovalPayload() {
  return {
    title: "LinkedIn launch draft for Workflow Guardrails",
    strategy: `Publish a concise launch post that frames the problem, highlights outcomes, and ends with a clear CTA.

Draft:
Shipping Workflow Guardrails this week.

Teams can now define approval gates for sensitive actions, keep an audit trail for every decision, and pause risky runs without stopping healthy work.

If you're running AI teammates in production, this gives you control without slowing execution.

Comment "guide" and I'll share the rollout checklist we used.`,
    channel: "linkedin",
    requestedAction: "approve_post_copy",
  } satisfies Record<string, unknown>;
}

export async function seedDatabase(db: Db) {
  console.log("Seeding database...");

  const [company] = await db
    .insert(companies)
    .values({
      name: "Paperclip Demo Co",
      description: "A demo autonomous company",
      status: "active",
      budgetMonthlyCents: 50000,
    })
    .returning();

  const [ceo] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "CEO Agent",
      role: "ceo",
      title: "Chief Executive Officer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo", args: ["hello from ceo"] },
      budgetMonthlyCents: 15000,
    })
    .returning();

  const [engineer] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Engineer Agent",
      role: "engineer",
      title: "Software Engineer",
      status: "idle",
      reportsTo: ceo!.id,
      adapterType: "process",
      adapterConfig: { command: "echo", args: ["hello from engineer"] },
      budgetMonthlyCents: 10000,
    })
    .returning();

  const [goal] = await db
    .insert(goals)
    .values({
      companyId: company!.id,
      title: "Ship V1",
      description: "Deliver first control plane release",
      level: "company",
      status: "active",
      ownerAgentId: ceo!.id,
    })
    .returning();

  const [project] = await db
    .insert(projects)
    .values({
      companyId: company!.id,
      goalId: goal!.id,
      name: "Control Plane MVP",
      description: "Implement core board + agent loop",
      status: "in_progress",
      leadAgentId: ceo!.id,
    })
    .returning();

  await db.insert(issues).values([
    {
      companyId: company!.id,
      projectId: project!.id,
      goalId: goal!.id,
      title: "Implement atomic task checkout",
      description: "Ensure in_progress claiming is conflict-safe",
      status: "todo",
      priority: "high",
      assigneeAgentId: engineer!.id,
      createdByAgentId: ceo!.id,
    },
    {
      companyId: company!.id,
      projectId: project!.id,
      goalId: goal!.id,
      title: "Add budget auto-pause",
      description: "Pause agent at hard budget ceiling",
      status: "backlog",
      priority: "medium",
      createdByAgentId: ceo!.id,
    },
  ]);

  await db.insert(approvals).values({
    companyId: company!.id,
    type: "approve_ceo_strategy",
    requestedByAgentId: ceo!.id,
    status: "pending",
    payload: createSampleLinkedInDraftApprovalPayload(),
  });

  console.log("Seed complete");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createDb(url);
  await seedDatabase(db);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await main();
}
