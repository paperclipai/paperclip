/**
 * Seed agent capability_tags based on adapter_type + role
 * Run: pnpm tsx scripts/seed-agent-capabilities.ts
 */
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";

const CAPABILITY_MAP: Record<string, Record<string, string[]>> = {
  // adapter_type → role → tags
  claude_local: {
    ceo: ["strategic", "governance", "delegation", "review"],
    coo: ["operations", "coordination", "monitoring", "reporting"],
    cto: ["architecture", "code-review", "infrastructure", "technical"],
    general: ["development", "analysis", "documentation"],
    analyst: ["research", "data-analysis", "reporting"],
    developer: ["coding", "testing", "debugging"],
    default: ["development", "task-execution"],
  },
  gemini_local: {
    ceo: ["strategic", "web-research", "vision", "multimodal"],
    analyst: ["research", "web-search", "vision", "data-analysis"],
    general: ["web-research", "vision", "multimodal"],
    default: ["web-research", "vision", "content-generation"],
  },
  "openclaw-gateway": {
    default: ["automation", "workflow", "integration", "multi-model"],
  },
  codex_local: {
    default: ["parallel-coding", "batch-generation", "refactoring"],
  },
};

function getCapabilities(adapterType: string, role: string): string[] {
  const adapterMap = CAPABILITY_MAP[adapterType] ?? CAPABILITY_MAP.claude_local;
  const roleTags = adapterMap[role] ?? adapterMap.default ?? ["task-execution"];
  // Add adapter-based base tags
  const baseTags: string[] = [];
  if (adapterType.includes("claude")) baseTags.push("claude");
  if (adapterType.includes("gemini")) baseTags.push("gemini");
  if (adapterType.includes("openclaw")) baseTags.push("openclaw");
  if (adapterType.includes("codex")) baseTags.push("codex");
  return [...new Set([...baseTags, ...roleTags])];
}

async function main() {
  const db = createDb();

  // Get all agents
  const agents = await db.execute(
    sql`SELECT id, name, adapter_type, role, capability_tags FROM agents`,
  );
  const rows = agents.rows as Array<{
    id: string;
    name: string;
    adapter_type: string;
    role: string;
    capability_tags: string[];
  }>;

  console.log(`Found ${rows.length} agents to update`);

  let updated = 0;
  for (const agent of rows) {
    // Skip if already has tags
    if (agent.capability_tags && agent.capability_tags.length > 0) {
      console.log(`  SKIP: ${agent.name} (${agent.adapter_type}/${agent.role}) — already has ${agent.capability_tags.length} tags`);
      continue;
    }

    const tags = getCapabilities(agent.adapter_type, agent.role);
    await db.execute(
      sql`UPDATE agents SET capability_tags = ${tags}, updated_at = NOW() WHERE id = ${agent.id}`,
    );
    console.log(`  OK: ${agent.name} → [${tags.join(", ")}]`);
    updated++;
  }

  console.log(`\nDone: ${updated} agents updated, ${rows.length - updated} skipped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
