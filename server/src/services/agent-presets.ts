import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentPresets, agents, type AgentPresetEntry } from "@paperclipai/db";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

interface CreatePresetInput {
  name: string;
  description?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  snapshot?: AgentPresetEntry[];
}

interface ApplyResult {
  appliedAgentIds: string[];
  unmatched: Array<{ agentNameKey: string; agentName: string }>;
  total: number;
  dryRun: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSnapshotEntries(rawSnapshot: unknown): AgentPresetEntry[] {
  if (!Array.isArray(rawSnapshot)) {
    throw unprocessable("Preset snapshot must be an array");
  }
  const seen = new Set<string>();
  return rawSnapshot.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw unprocessable(`Preset snapshot entry ${index} must be an object`);
    }
    const agentName = typeof entry.agentName === "string" ? entry.agentName : "";
    const rawKey = typeof entry.agentNameKey === "string" && entry.agentNameKey.length > 0
      ? entry.agentNameKey
      : deriveAgentUrlKey(agentName);
    const agentNameKey = rawKey.length > 0 ? rawKey : `agent-${index}`;
    if (seen.has(agentNameKey)) {
      throw unprocessable(`Duplicate agentNameKey in preset snapshot: ${agentNameKey}`);
    }
    seen.add(agentNameKey);
    const adapterType = typeof entry.adapterType === "string" ? entry.adapterType.trim() : "";
    if (adapterType.length === 0) {
      throw unprocessable(`Preset snapshot entry ${agentNameKey} is missing adapterType`);
    }
    const adapterConfig = isPlainRecord(entry.adapterConfig) ? entry.adapterConfig : {};
    return {
      agentNameKey,
      agentName: agentName.length > 0 ? agentName : agentNameKey,
      adapterType,
      adapterConfig,
    } satisfies AgentPresetEntry;
  });
}

export function agentPresetService(db: Db) {
  async function captureCompanySnapshot(companyId: string): Promise<AgentPresetEntry[]> {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
      .orderBy(asc(agents.name));

    const entries: AgentPresetEntry[] = [];
    const seenKeys = new Set<string>();
    for (const row of rows) {
      let key = deriveAgentUrlKey(row.name) ?? row.id;
      let suffix = 2;
      while (seenKeys.has(key)) {
        key = `${deriveAgentUrlKey(row.name) ?? row.id}-${suffix}`;
        suffix += 1;
      }
      seenKeys.add(key);
      entries.push({
        agentNameKey: key,
        agentName: row.name,
        adapterType: row.adapterType,
        adapterConfig: isPlainRecord(row.adapterConfig) ? row.adapterConfig : {},
      });
    }
    return entries;
  }

  async function list(companyId: string) {
    return db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.companyId, companyId))
      .orderBy(asc(agentPresets.createdAt));
  }

  async function getById(companyId: string, presetId: string) {
    const rows = await db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.companyId, companyId), eq(agentPresets.id, presetId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function create(companyId: string, input: CreatePresetInput) {
    const name = input.name.trim();
    if (name.length === 0) {
      throw unprocessable("Preset name is required");
    }
    if (name.length > 120) {
      throw unprocessable("Preset name must be 120 characters or fewer");
    }

    const snapshot = input.snapshot
      ? normalizeSnapshotEntries(input.snapshot)
      : await captureCompanySnapshot(companyId);

    if (snapshot.length === 0) {
      throw unprocessable("Cannot save an empty preset");
    }

    const existing = await db
      .select({ id: agentPresets.id })
      .from(agentPresets)
      .where(and(eq(agentPresets.companyId, companyId), eq(agentPresets.name, name)))
      .limit(1);
    if (existing.length > 0) {
      throw conflict(`Preset with name '${name}' already exists`);
    }

    const inserted = await db
      .insert(agentPresets)
      .values({
        companyId,
        name,
        description: input.description ?? null,
        snapshot,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    return inserted;
  }

  async function remove(companyId: string, presetId: string) {
    const deleted = await db
      .delete(agentPresets)
      .where(and(eq(agentPresets.companyId, companyId), eq(agentPresets.id, presetId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    return deleted;
  }

  async function apply(
    companyId: string,
    presetId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<ApplyResult> {
    const preset = await getById(companyId, presetId);
    if (!preset) {
      throw notFound("Preset not found");
    }
    const snapshot: AgentPresetEntry[] = Array.isArray(preset.snapshot) ? preset.snapshot : [];
    if (snapshot.length === 0) {
      return { appliedAgentIds: [], unmatched: [], total: 0, dryRun: !!options.dryRun };
    }

    const companyAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

    const keyToAgent = new Map<string, { id: string; name: string }>();
    for (const agent of companyAgents) {
      const key = deriveAgentUrlKey(agent.name);
      if (key) keyToAgent.set(key, { id: agent.id, name: agent.name });
    }

    const appliedAgentIds: string[] = [];
    const unmatched: ApplyResult["unmatched"] = [];
    const matches: Array<{ agentId: string; entry: AgentPresetEntry }> = [];
    for (const entry of snapshot) {
      const match = keyToAgent.get(entry.agentNameKey);
      if (!match) {
        unmatched.push({ agentNameKey: entry.agentNameKey, agentName: entry.agentName });
        continue;
      }
      matches.push({ agentId: match.id, entry });
    }

    if (options.dryRun) {
      return {
        appliedAgentIds: matches.map((m) => m.agentId),
        unmatched,
        total: snapshot.length,
        dryRun: true,
      };
    }

    await db.transaction(async (tx) => {
      for (const { agentId, entry } of matches) {
        await tx
          .update(agents)
          .set({
            adapterType: entry.adapterType,
            adapterConfig: entry.adapterConfig ?? {},
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));
        appliedAgentIds.push(agentId);
      }
    });

    return { appliedAgentIds, unmatched, total: snapshot.length, dryRun: false };
  }

  return {
    list,
    getById,
    create,
    remove,
    apply,
    captureCompanySnapshot,
  };
}
