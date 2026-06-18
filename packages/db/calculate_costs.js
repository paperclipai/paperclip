import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);

const PRICES = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cached: 0.30 },
  "claude-opus-4-7": { input: 15.0, output: 75.0, cached: 1.50 },
  "claude-opus-4-6[1m]": { input: 15.0, output: 75.0, cached: 1.50 },
  "claude-haiku-4-5": { input: 0.80, output: 4.0, cached: 0.08 },
  "gpt-5.3-codex": { input: 2.50, output: 10.0, cached: 0.25 },
};

function getPrice(model) {
  if (PRICES[model]) return PRICES[model];
  if (model.includes("sonnet")) return PRICES["claude-sonnet-4-6"];
  if (model.includes("opus")) return PRICES["claude-opus-4-7"];
  if (model.includes("haiku")) return PRICES["claude-haiku-4-5"];
  if (model.includes("codex")) return PRICES["gpt-5.3-codex"];
  return { input: 2.0, output: 10.0, cached: 0.20 }; // Default fallback
}

async function main() {
  console.log("Querying DB...");
  const events = await sql`
    SELECT 
      ce.agent_id,
      COALESCE(a.name, ce.agent_id::text) AS agent_name,
      ce.model,
      ce.input_tokens,
      ce.cached_input_tokens,
      ce.output_tokens,
      ce.occurred_at
    FROM cost_events ce
    LEFT JOIN agents a ON a.id = ce.agent_id
    WHERE ce.occurred_at >= '2026-05-01 00:00:00+00';
  `;

  const agents = await sql`
    SELECT id, name, budget_monthly_cents FROM agents;
  `;

  const agentMap = {};
  for (const agent of agents) {
    agentMap[agent.id] = {
      id: agent.id,
      name: agent.name,
      budgetUsd: agent.budget_monthly_cents / 100.0,
      mtdSpend: 0.0,
      dailySpends: {},
      events: []
    };
  }

  for (const ev of events) {
    const agentId = ev.agent_id;
    if (!agentMap[agentId]) {
      agentMap[agentId] = {
        id: agentId,
        name: ev.agent_name,
        budgetUsd: 0.0,
        mtdSpend: 0.0,
        dailySpends: {},
        events: []
      };
    }
    const price = getPrice(ev.model);
    const regularInput = Math.max(ev.input_tokens - ev.cached_input_tokens, 0);
    const cachedInput = ev.cached_input_tokens;
    const cost = (regularInput * price.input + cachedInput * price.cached + ev.output_tokens * price.output) / 1_000_000.0;
    
    agentMap[agentId].mtdSpend += cost;
    const dateStr = new Date(ev.occurred_at).toISOString().split('T')[0];
    agentMap[agentId].dailySpends[dateStr] = (agentMap[agentId].dailySpends[dateStr] || 0) + cost;
    agentMap[agentId].events.push(ev);
  }

  console.log("Economics report:");
  const activeAgents = Object.values(agentMap).filter(a => a.budgetUsd > 0 || a.mtdSpend > 0);
  for (const a of activeAgents) {
    const days = Object.keys(a.dailySpends).length;
    // Daily burn is total spend / elapsed days in May (28 days elapsed)
    const elapsedDays = 28;
    const dailyBurn = a.mtdSpend / elapsedDays;
    const daysUntilCap = dailyBurn > 0 && a.budgetUsd > 0 ? (a.budgetUsd - a.mtdSpend) / dailyBurn : null;
    
    console.log(`Agent: ${a.name} (${a.id})`);
    console.log(`  Monthly Cap: $${a.budgetUsd.toFixed(2)}`);
    console.log(`  MTD Spend:   $${a.mtdSpend.toFixed(4)}`);
    console.log(`  Daily Burn:  $${dailyBurn.toFixed(4)}`);
    console.log(`  Days-until-cap: ${daysUntilCap !== null ? daysUntilCap.toFixed(1) : "N/A"}`);
  }

  await sql.end();
}

main().catch(console.error);
