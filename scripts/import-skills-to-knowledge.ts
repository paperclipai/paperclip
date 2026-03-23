/**
 * Import skills from Vault katalog into knowledge_store
 * Run: pnpm tsx scripts/import-skills-to-knowledge.ts
 */
import * as fs from "fs";
import * as path from "path";

const KNOWLEDGE_URL = process.env.KNOWLEDGE_URL ?? "http://localhost:3100/api/knowledge/bulk-import";
const VAULT_SKILLS = path.join(
  process.env.HOME ?? "/Users/evohaus",
  "Documents/EvoHaus-Vault/Hafiza/zeka/katalog.md",
);

async function main() {
  if (!fs.existsSync(VAULT_SKILLS)) {
    console.error(`Skill katalog not found: ${VAULT_SKILLS}`);
    process.exit(1);
  }

  const content = fs.readFileSync(VAULT_SKILLS, "utf8");
  const lines = content.split("\n");

  // Parse skill entries from markdown table
  const entries: Array<{
    title: string;
    body: string;
    category: string;
    tags: string[];
    sourcePlatform: string;
  }> = [];

  let currentSection = "";
  for (const line of lines) {
    // Track section headers
    if (line.startsWith("## ") || line.startsWith("### ")) {
      currentSection = line.replace(/^#+\s*/, "").trim();
      continue;
    }

    // Parse table rows (| name | description | ...)
    if (line.startsWith("|") && !line.startsWith("|-") && !line.includes("---")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);

      if (cells.length >= 2 && cells[0] !== "Skill" && cells[0] !== "Ad" && cells[0] !== "Name") {
        const skillName = cells[0];
        const description = cells.slice(1).join(" — ");

        entries.push({
          title: `Skill: ${skillName}`,
          body: `${description}\n\nSection: ${currentSection}`,
          category: "skill_note",
          tags: ["skill", currentSection.toLowerCase().replace(/\s+/g, "-")],
          sourcePlatform: "vault",
        });
      }
    }

    // Also catch bullet-point skill listings
    if (line.match(/^[-*]\s+\*\*/) || line.match(/^[-*]\s+`/)) {
      const skillMatch = line.match(/[-*]\s+\*\*(.+?)\*\*:?\s*(.*)/);
      const codeMatch = line.match(/[-*]\s+`(.+?)`\s*[-—:]\s*(.*)/);

      if (skillMatch) {
        entries.push({
          title: `Skill: ${skillMatch[1]}`,
          body: `${skillMatch[2]}\n\nSection: ${currentSection}`,
          category: "skill_note",
          tags: ["skill", currentSection.toLowerCase().replace(/\s+/g, "-")],
          sourcePlatform: "vault",
        });
      } else if (codeMatch) {
        entries.push({
          title: `Skill: ${codeMatch[1]}`,
          body: `${codeMatch[2]}\n\nSection: ${currentSection}`,
          category: "skill_note",
          tags: ["skill", currentSection.toLowerCase().replace(/\s+/g, "-")],
          sourcePlatform: "vault",
        });
      }
    }
  }

  console.log(`Parsed ${entries.length} skills from katalog`);

  if (entries.length === 0) {
    console.log("No skills found to import");
    process.exit(0);
  }

  // Bulk import in batches of 50
  const BATCH_SIZE = 50;
  let imported = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    try {
      const response = await fetch(KNOWLEDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: batch }),
      });

      if (response.ok) {
        const result = await response.json();
        imported += (result as any).imported ?? batch.length;
        console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} skills imported`);
      } else {
        console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: HTTP ${response.status}`);
      }
    } catch (err: any) {
      console.error(`  Batch error: ${err.message}`);
    }
  }

  console.log(`\nDone: ${imported} skills imported to knowledge_store`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
