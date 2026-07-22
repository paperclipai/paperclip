import { createDb } from "./client.js";
import { companies, agents, goals, projects, issues } from "./schema/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

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

console.log("Seed complete");
process.exit(0);
