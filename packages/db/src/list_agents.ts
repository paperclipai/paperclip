import { createDb } from "./client.js";
import { agents, companies } from "./schema/index.js";
import { eq } from "drizzle-orm";
const db = createDb(process.env.DATABASE_URL!);
const all = await db.select({ id: agents.id, name: agents.name, companyId: agents.companyId })
  .from(agents);
for (const a of all) console.log(`${a.id}  ${a.name}`);
process.exit(0);
