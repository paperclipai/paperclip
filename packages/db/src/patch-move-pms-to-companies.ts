/**
 * IDEMPOTENT PATCH: Move PM agents to their respective project companies + set CMO hierarchy.
 * Safe to re-run — uses UPDATE with WHERE clauses.
 *
 * Run: DATABASE_URL="postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip" npx tsx packages/db/src/patch-move-pms-to-companies.ts
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url);

// PM agent name → target company ID
const pmMoves: Record<string, string> = {
  "Navico PM": "1e8b09d9-d89c-4ff8-a79e-3331dd3822be",
  "HukukBank PM": "7fdd50e3-3fcf-41fe-b17b-27b8dcffcc4d",
  "MersinSteel PM": "cb65dc43-3a55-4003-9a51-92844749ea33",
  "Emir PM": "30093a28-01a3-4565-a115-0fc2ea26677b",
  "Celal PM": "e716cea2-1f3f-459d-b38c-cd404bbcc943",
  "Transaktas PM": "8a4472da-334d-495e-b7d0-b7470818b3b3",
  "EkstreAI PM": "e8c5855f-e93c-4908-8fca-a0ed077fa51b",
  "KsAtlas PM": "6dfc8c42-ef4f-498a-8dff-02d7de151130",
  "PsikoRuya PM": "2df6b8de-46b4-4b9e-96af-266148061556",
  "Vitalix PM": "ded5f5ce-4c0a-49a2-89e1-6ae7f4453725",
  "MissionCtrl PM": "616e6556-34af-4ca2-b416-35f92a9eba8b",
};

// Agents that should report to the CMO
const cmoReports = ["PAZARLAMA", "REKLAM", "CRM", "EMAIL", "WHATSAPP"];

async function main() {
  // === Part 1: Move PMs to their project companies ===
  console.log("=== Moving PM agents to project companies ===\n");

  let moved = 0;
  let skipped = 0;

  for (const [agentName, companyId] of Object.entries(pmMoves)) {
    const result = await sql`
      UPDATE agents
      SET company_id = ${companyId}, updated_at = NOW()
      WHERE name = ${agentName}
        AND company_id != ${companyId}
      RETURNING id, name
    `;

    if (result.length > 0) {
      console.log(`  Moved: ${agentName} → company ${companyId}`);
      moved++;
    } else {
      // Check if agent exists at all
      const exists = await sql`
        SELECT id, company_id FROM agents WHERE name = ${agentName}
      `;
      if (exists.length === 0) {
        console.log(`  WARN: Agent "${agentName}" not found`);
      } else {
        console.log(`  Skip: ${agentName} (already in correct company)`);
      }
      skipped++;
    }
  }

  console.log(`\nPM moves: ${moved} moved, ${skipped} skipped\n`);

  // === Part 2: Set CMO hierarchy ===
  console.log("=== Setting CMO reports_to hierarchy ===\n");

  // Find CMO agent
  const cmoRows = await sql`
    SELECT id, name FROM agents WHERE name = 'EvoHaus CMO'
  `;

  if (cmoRows.length === 0) {
    console.log("  WARN: EvoHaus CMO agent not found — skipping hierarchy setup");
  } else {
    const cmoId = cmoRows[0].id;
    console.log(`  Found CMO: ${cmoRows[0].name} (${cmoId})`);

    let hierarchySet = 0;

    for (const agentName of cmoReports) {
      const result = await sql`
        UPDATE agents
        SET reports_to = ${cmoId}, updated_at = NOW()
        WHERE name = ${agentName}
          AND (reports_to IS NULL OR reports_to != ${cmoId})
        RETURNING id, name
      `;

      if (result.length > 0) {
        console.log(`  Set: ${agentName} → reports to CMO`);
        hierarchySet++;
      } else {
        const exists = await sql`
          SELECT id, reports_to FROM agents WHERE name = ${agentName}
        `;
        if (exists.length === 0) {
          console.log(`  WARN: Agent "${agentName}" not found`);
        } else {
          console.log(`  Skip: ${agentName} (already reports to CMO)`);
        }
      }
    }

    console.log(`\nCMO hierarchy: ${hierarchySet} updated`);
  }

  console.log("\nDone!");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
