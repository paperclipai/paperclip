import { agents, createDb } from "../packages/db/src/index.js";
import { eq } from "drizzle-orm";
import { loadConfig } from "../server/src/config.js";
import { budgetService } from "../server/src/services/budgets.js";

interface CapInput {
  agentId: string;
  amount: number;
  label: string;
}

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const budgets = budgetService(db);

  const caps: CapInput[] = [
    { agentId: "43451930-0000-0000-0000-000000000000", amount: 200, label: "CRM-1" },
    { agentId: "58952822-0000-0000-0000-000000000000", amount: 20, label: "Compliance-1" },
  ];

  const overrideAgent = parseFlag("--agent");
  const overrideAmount = parseFlag("--amount");
  if (overrideAgent && overrideAmount) {
    caps.length = 0;
    caps.push({ agentId: overrideAgent, amount: Number(overrideAmount), label: overrideAgent });
  }

  for (const cap of caps) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name })
      .from(agents)
      .where(eq(agents.id, cap.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      console.warn(`- ${cap.label} (${cap.agentId}): agent not found, skipping`);
      continue;
    }

    const summary = await budgets.upsertPolicy(
      agent.companyId,
      {
        scopeType: "agent",
        scopeId: agent.id,
        metric: "heartbeat_count",
        windowKind: "calendar_day_utc",
        amount: cap.amount,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
      null,
    );

    console.log(
      `- ${cap.label} (${agent.name ?? agent.id}): cap=${summary.amount} heartbeats/day, observed=${summary.observedAmount}, status=${summary.status}`,
    );
  }

  console.log("Heartbeat-count budget caps seeded.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Heartbeat-count cap seed failed: ${message}`);
  process.exitCode = 1;
});
