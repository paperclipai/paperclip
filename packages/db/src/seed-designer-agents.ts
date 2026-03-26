/**
 * IDEMPOTENT SEED: Insert designer agents into 6 companies with Gemini 3.1 Pro model.
 * Also updates existing design agents to use gemini-3.1-pro.
 * Safe to re-run — skips existing agents by name+company.
 *
 * Run: DATABASE_URL="postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip" npx tsx packages/db/src/seed-designer-agents.ts
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url);

// Company ID mapping
const companies = {
  Navico: "1e8b09d9-d89c-4ff8-a79e-3331dd3822be",
  HukukBank: "7fdd50e3-3fcf-41fe-b17b-27b8dcffcc4d",
  Emir: "30093a28-01a3-4565-a115-0fc2ea26677b",
  MersinSteel: "cb65dc43-3a55-4003-9a51-92844749ea33",
  "Celal Isinlik": "e716cea2-1f3f-459d-b38c-cd404bbcc943",
  "EVOHAUS AI": "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820",
} as const;

// Designer agent template
const designerTemplate = {
  role: "designer",
  title: "UI/UX Designer",
  adapter_type: "gemini_local",
  status: "idle",
  adapter_config: { model: "gemini-3.1-pro" },
  capabilities: "ui-design,ux-research,figma,prototyping",
  metadata: { humanHeartbeat: "2h" },
};

// Existing design agents to update model
const existingDesignAgents = ["UI Designer", "gstack-design-lead"];

async function main() {
  let inserted = 0;
  let skipped = 0;

  // --- Part 1: Insert new designer agents ---
  for (const [companyName, companyId] of Object.entries(companies)) {
    const agentName = `${companyName} Designer`;
    const specialty = `${companyName} ekibi`;

    // Check if already exists
    const existing = await sql`
      SELECT id FROM agents
      WHERE name = ${agentName} AND company_id = ${companyId}
    `;

    if (existing.length > 0) {
      console.log(`SKIP: ${agentName} already exists in ${companyName}`);
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO agents (
        name, role, title, adapter_type, status,
        adapter_config, capabilities, specialty, metadata, company_id
      ) VALUES (
        ${agentName},
        ${designerTemplate.role},
        ${designerTemplate.title},
        ${designerTemplate.adapter_type},
        ${designerTemplate.status},
        ${sql.json(designerTemplate.adapter_config)},
        ${designerTemplate.capabilities},
        ${specialty},
        ${sql.json(designerTemplate.metadata)},
        ${companyId}
      )
    `;

    console.log(`INSERT: ${agentName} -> ${companyName}`);
    inserted++;
  }

  // --- Part 2: Update existing design agents to gemini-3.1-pro ---
  let updated = 0;

  for (const agentName of existingDesignAgents) {
    const result = await sql`
      UPDATE agents
      SET adapter_config = jsonb_set(
        COALESCE(adapter_config, '{}'::jsonb),
        '{model}',
        '"gemini-3.1-pro"'
      ),
      updated_at = NOW()
      WHERE name = ${agentName}
      RETURNING id, name
    `;

    if (result.length > 0) {
      console.log(`UPDATE: ${agentName} -> gemini-3.1-pro`);
      updated++;
    } else {
      console.log(`NOT FOUND: ${agentName} (skipping update)`);
    }
  }

  console.log(`\nDone!`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (already exist): ${skipped}`);
  console.log(`  Updated to gemini-3.1-pro: ${updated}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
