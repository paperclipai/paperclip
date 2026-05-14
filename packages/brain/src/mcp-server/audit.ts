import type { BrainDb } from "../db/client.js";
import { brainAccessLog } from "../db/schema/brain-access-log.js";

export type ToolName = "search_vault" | "get_note" | "list_scope";

export interface AccessLogEntry {
  agentId: string;
  tool: ToolName;
  query?: string | null;
  path?: string | null;
  returnedPaths: string[];
  latencyMs: number;
  ok: boolean;
}

export async function logAccess(db: BrainDb, entry: AccessLogEntry): Promise<void> {
  await db.insert(brainAccessLog).values({
    agentId: entry.agentId,
    tool: entry.tool,
    query: entry.query ?? null,
    path: entry.path ?? null,
    returnedPaths: entry.returnedPaths,
    latencyMs: entry.latencyMs,
    ok: entry.ok,
  });
}
