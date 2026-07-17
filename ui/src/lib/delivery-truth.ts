import type {
  DeliveryEventAuthority,
  DeliveryEventState,
  DeliverySnapshotV1,
  DeliveryStage,
} from "@paperclipai/shared";

export type DeliveryAuthorityPresentation = {
  label: string;
  description: string;
  tone: "verified" | "asserted" | "claimed" | "unverified" | "empty";
};

const AUTHORITY_PRESENTATIONS: Record<DeliveryEventAuthority, DeliveryAuthorityPresentation> = {
  provider_verified: {
    label: "Provider verified",
    description: "Observed directly from the external provider.",
    tone: "verified",
  },
  paperclip_verified: {
    label: "Paperclip verified",
    description: "Verified by a Paperclip-owned operation.",
    tone: "verified",
  },
  user_asserted: {
    label: "User asserted",
    description: "Reported by a board user; the provider did not verify it.",
    tone: "asserted",
  },
  agent_claim: {
    label: "Agent claim",
    description: "Reported by an agent; the provider did not verify it.",
    tone: "claimed",
  },
  legacy_unverified: {
    label: "Legacy, unverified",
    description: "Imported from older work-product data without provider verification.",
    tone: "unverified",
  },
};

export function deliveryAuthorityPresentation(
  authority: DeliveryEventAuthority | null,
): DeliveryAuthorityPresentation {
  if (!authority) {
    return {
      label: "No evidence",
      description: "No delivery evidence has been recorded for this stage.",
      tone: "empty",
    };
  }
  return AUTHORITY_PRESENTATIONS[authority];
}

export function deliveryStageLabel(stage: DeliveryStage): string {
  return stage
    .split("_")
    .map((part) => part === "qa" ? "QA" : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function deliveryStateLabel(state: DeliveryEventState): string {
  return state.replaceAll("_", " ");
}

export function deliverySnapshotFreshness(snapshot: DeliverySnapshotV1) {
  const stageValues = Object.values(snapshot.stages);
  const evidencedStageCount = stageValues.filter((stage) => stage.eventId !== null).length;
  const staleStageCount = stageValues.filter((stage) => stage.eventId !== null && stage.stale).length;
  return {
    evidencedStageCount,
    staleStageCount,
    hasStaleEvidence: staleStageCount > 0,
  };
}
