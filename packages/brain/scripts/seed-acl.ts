import { createBrainDb } from "../src/db/client.js";
import { setAcl } from "../src/db/queries.js";

interface Seed {
  agentId: string;
  folders: string[];
  description: string;
}

const SEEDS: Seed[] = [
  {
    agentId: "CEO",
    folders: ["AI", "Dokumente"],
    description: "Paperclip CEO-Agent — MVP scope: AI and Dokumente",
  },
  {
    agentId: "walter",
    folders: [
      "AI",
      "Dokumente",
      "Marketing",
      "Pressemitteilungen",
      "Analysen",
      "CAO",
      "Biographie",
    ],
    description: "Walter himself (Claude Code, Claude Desktop, n8n) — broad owner access",
  },
];

async function main(): Promise<void> {
  const url = process.env.BRAIN_DATABASE_URL;
  if (!url) throw new Error("BRAIN_DATABASE_URL must be set");
  const handle = createBrainDb(url);
  try {
    for (const s of SEEDS) {
      await setAcl(handle.db, s.agentId, s.folders, s.description);
      console.log(`[seed-acl] ${s.agentId} -> [${s.folders.join(",")}]`);
    }
    console.log("[seed-acl] done.");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error("[seed-acl] fatal:", err);
  process.exit(1);
});
