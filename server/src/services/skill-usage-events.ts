import type { SkillUsageEventKind } from "@paperclipai/shared";
import type { companySkillUsageEvents } from "@paperclipai/db";

export const PAPERCLIP_SKILL_USAGE_EVENT_TYPE = "paperclip.skill.usage";

export type PaperclipSkillUsageRuntimeEvent = {
  adapter: string;
  eventKind: SkillUsageEventKind;
  skillKey: string;
  skillRuntimeName: string | null;
  skillVersionId: string | null;
};

export interface ParsedAdapterEvent {
  eventType?: string;
  payload?: Record<string, unknown> | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringToLower(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized?.toLowerCase() ?? null;
}

function parseRuntimeEventObject(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

function isLoadedOrInvoked(value: unknown): value is SkillUsageEventKind {
  return value === "loaded" || value === "invoked";
}

export function parsePaperclipSkillUsageEvent(event: ParsedAdapterEvent): PaperclipSkillUsageRuntimeEvent | null {
  if (event.eventType?.trim() !== PAPERCLIP_SKILL_USAGE_EVENT_TYPE) return null;
  const payload = parseRuntimeEventObject(event.payload);

  const skillKey = normalizeText(payload.skillKey);
  if (!skillKey) return null;

  const adapter = normalizeText(payload.adapter);
  if (!adapter) return null;

  const rawEventKind = asStringToLower(payload.eventKind);
  if (!isLoadedOrInvoked(rawEventKind)) return null;

  const skillRuntimeName = normalizeText(payload.skillRuntimeName);

  return {
    adapter,
    eventKind: rawEventKind,
    skillKey,
    skillRuntimeName,
    skillVersionId: normalizeText(payload.skillVersionId),
  };
}

export type SkillUsageEventInsert = Omit<
  typeof companySkillUsageEvents.$inferInsert,
  "id" | "createdAt"
>;

export type SkillIdLookup = ReadonlyMap<string, string>;

export function buildSkillUsageInsertRows(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  events: readonly PaperclipSkillUsageRuntimeEvent[];
  skillIdByKey: SkillIdLookup;
}): SkillUsageEventInsert[] {
  const seen = new Set<string>();
  const rows: SkillUsageEventInsert[] = [];
  for (const event of input.events) {
    const skillKey = normalizeText(event.skillKey);
    if (!skillKey) continue;
    const eventKind = event.eventKind;
    if (!isLoadedOrInvoked(eventKind)) continue;

    const adapter = normalizeText(event.adapter);
    if (!adapter) continue;

    const dedupeKey = `${skillKey}::${eventKind}::${adapter}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    rows.push({
      companyId: input.companyId,
      skillKey,
      skillId: input.skillIdByKey.get(skillKey) ?? null,
      skillVersionId: normalizeText(event.skillVersionId),
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      adapter,
      eventKind,
    });
  }
  return rows;
}
