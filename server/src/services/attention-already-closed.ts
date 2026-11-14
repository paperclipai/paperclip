import type { AttentionAlreadyClosedDetails, AttentionSourceKind } from "@paperclipai/shared";
import { conflict } from "../errors.js";

/**
 * The 409 for "a different person answered or closed this first" (PAP-749
 * plan §2, special conditions). The first answer wins; the details name who
 * resolved the source so the UI can show "Already answered by @x".
 */
export function attentionAlreadyClosedError(input: {
  sourceKind: AttentionSourceKind;
  sourceId: string;
  status: string;
  resolvedByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedAt?: Date | string | null;
}) {
  const details: AttentionAlreadyClosedDetails = {
    code: "attention_already_closed",
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    status: input.status,
    resolvedByUserId: input.resolvedByUserId ?? null,
    resolvedByAgentId: input.resolvedByAgentId ?? null,
    resolvedAt: input.resolvedAt ? new Date(input.resolvedAt).toISOString() : null,
  };
  return conflict("Already answered", details);
}
