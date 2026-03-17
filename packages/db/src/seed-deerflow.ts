/**
 * Seed script: creates a Paperclip company with agents using both adapters.
 *
 * - claude_local agents: use Claude Code CLI (Max subscription)
 * - deerflow agents: use Qwen3.5-9B via vLLM (local GPU, no API key)
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx packages/db/src/seed-deerflow.ts
 */
import { createDb } from "./client.js";
import { companies, agents, agentManagers, goals, projects } from "./schema/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

console.log("Seeding agent network...");

// Default DeerFlow connection URLs (Docker Compose service names)
const DEERFLOW_URL = "http://deerflow-langgraph:2024";
const GATEWAY_URL = "http://deerflow-gateway:8001";

const [company] = await db
  .insert(companies)
  .values({
    name: "Agent Network",
    description: "Autonomous agent company: Claude (Max) for reasoning, Qwen (local) for execution",
    status: "active",
    budgetMonthlyCents: 100000,
  })
  .returning();

// --- Research Agent (Claude via Max subscription) ---
const [researcher] = await db
  .insert(agents)
  .values({
    companyId: company!.id,
    name: "Research Agent",
    role: "researcher",
    title: "Deep Research Specialist",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        wakeOnDemand: true,
        maxConcurrentRuns: 2,
      },
    },
    budgetMonthlyCents: 30000,
  })
  .returning();

// --- Coding Agent (Claude via Max subscription) ---
const [coder] = await db
  .insert(agents)
  .values({
    companyId: company!.id,
    name: "Coding Agent",
    role: "engineer",
    title: "Software Engineer",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    budgetMonthlyCents: 40000,
  })
  .returning();

// --- Data Analysis Agent (Qwen3.5 via DeerFlow/vLLM) ---
const [analyst] = await db
  .insert(agents)
  .values({
    companyId: company!.id,
    name: "Data Analysis Agent",
    role: "researcher",
    title: "Data Analyst",
    status: "idle",
    adapterType: "deerflow",
    adapterConfig: {
      deerflowUrl: DEERFLOW_URL,
      gatewayUrl: GATEWAY_URL,
      model: "qwen3.5-9b",
      skill: "data-analysis",
      thinkingEnabled: false,
      subagentEnabled: false,
      timeoutSec: 600,
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    budgetMonthlyCents: 30000,
  })
  .returning();

// --- Manager relationships ---
await db.insert(agentManagers).values([
  { agentId: coder!.id, managerId: researcher!.id },
  { agentId: analyst!.id, managerId: researcher!.id },
]);

// --- Company goal + project ---
const [goal] = await db
  .insert(goals)
  .values({
    companyId: company!.id,
    title: "Build Agent Network",
    description: "Stand up a fully autonomous research and engineering team",
    level: "company",
    status: "active",
    ownerAgentId: researcher!.id,
  })
  .returning();

await db.insert(projects).values({
  companyId: company!.id,
  goalId: goal!.id,
  name: "Agent Network Bootstrap",
  description: "Configure and validate the agent network",
  status: "in_progress",
  leadAgentId: researcher!.id,
});

console.log(`Seed complete — company "${company!.name}" (${company!.id})`);
console.log(`  Research Agent (claude_local): ${researcher!.id}`);
console.log(`  Coding Agent  (claude_local):  ${coder!.id}`);
console.log(`  Data Agent    (deerflow):      ${analyst!.id}`);
process.exit(0);
