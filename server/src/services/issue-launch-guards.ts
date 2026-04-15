export type LaunchChecklistMetadata = {
  copyFinal?: boolean;
  linksValid?: boolean;
  scheduledTime?: string | null;
  proofLine?: string | null;
  sentLedgerEntry?: string | null;
  proof?: {
    urlOrPostId?: string | null;
    timestamp?: string | null;
    platformChannel?: string | null;
  } | null;
};

const LAUNCH_KEYWORDS = ["launch", "publish", "go live", "release", "scheduled", "campaign", "post"]; 

export function isLaunchIssueText(title: string | null | undefined, description: string | null | undefined) {
  const haystack = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  return LAUNCH_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

export function hasProofMetadata(metadata: LaunchChecklistMetadata | null | undefined) {
  const proof = metadata?.proof;
  if (!proof) return false;
  return Boolean(
    typeof proof.urlOrPostId === "string" && proof.urlOrPostId.trim() &&
    typeof proof.timestamp === "string" && proof.timestamp.trim() &&
    typeof proof.platformChannel === "string" && proof.platformChannel.trim(),
  );
}

export function evaluateLaunchChecklist(input: {
  metadata: LaunchChecklistMetadata | null | undefined;
  hasImageAttachment: boolean;
  hasApprovedLinkedApproval: boolean;
}) {
  const metadata = input.metadata ?? {};
  const checks = {
    copyFinal: metadata.copyFinal === true,
    imageAttached: input.hasImageAttachment,
    linksValid: metadata.linksValid === true,
    approvalReceived: input.hasApprovedLinkedApproval,
    scheduledTimeSet: Boolean(typeof metadata.scheduledTime === "string" && metadata.scheduledTime.trim()),
    proofCaptured: hasProofMetadata(metadata),
    proofLineLogged: Boolean(typeof metadata.proofLine === "string" && metadata.proofLine.trim()),
    sentLedgerLogged: Boolean(typeof metadata.sentLedgerEntry === "string" && metadata.sentLedgerEntry.trim()),
  };

  const missing = Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return {
    checks,
    complete: missing.length === 0,
    missing,
  };
}
