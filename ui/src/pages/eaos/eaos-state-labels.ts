/**
 * LET-326: shared vocabulary for the read-only /eaos Sandbox & runtime
 * dashboard. Every chip is text-first (icon optional) so screen readers
 * and users with color-vision differences see the same disposition the
 * sighted, color-vision-typical user sees.
 *
 * "Source class" answers "where did this number come from?" and is the
 * truth contract surfaced by the LET-314 read model:
 *   - Backend-backed : a real lease row + advanced sandbox state
 *   - Backend-derived: a real lease row but the state has not advanced
 *                      past requested/provisioning
 *   - Preview        : no provider lease id (scaffold/preview only)
 *   - Unknown        : the read model is missing the field entirely
 *
 * Mutating controls are never rendered in this slice. The lifecycle chip
 * vocabulary covers the surfaces a future approval-gated control would
 * need so operators learn the labels before any control exists.
 */

import type {
  SandboxLeaseReadModel,
  SandboxLeaseSandboxState,
  SandboxLeaseTruth,
} from "@/api/sandbox";

export type SourceClass = "backend-backed" | "backend-derived" | "preview" | "unknown";

export interface SourceClassChip {
  label: string;
  tone: "neutral" | "info" | "warn";
  description: string;
}

export const SOURCE_CLASS_LABELS: Record<SourceClass, SourceClassChip> = {
  "backend-backed": {
    label: "Backend-backed",
    tone: "neutral",
    description: "Sourced from a real lease/provider row.",
  },
  "backend-derived": {
    label: "Backend-derived",
    tone: "info",
    description: "Computed from a lease row that has not advanced past requested/provisioning.",
  },
  preview: {
    label: "Preview",
    tone: "warn",
    description: "No provider lease id; no live runtime implied.",
  },
  unknown: {
    label: "Unknown",
    tone: "warn",
    description: "The backend did not return a source classification for this row.",
  },
};

export function truthToSourceClass(truth: SandboxLeaseTruth | null | undefined): SourceClass {
  switch (truth) {
    case "backend-backed":
      return "backend-backed";
    case "derived":
      return "backend-derived";
    case "preview":
      return "preview";
    default:
      return "unknown";
  }
}

export type SandboxLifecycleChip =
  | { kind: "sandbox-state"; state: SandboxLeaseSandboxState; label: string; tone: ChipTone }
  | { kind: "lease-status"; status: string; label: string; tone: ChipTone }
  | { kind: "unknown"; label: string; tone: ChipTone };

export type ChipTone = "neutral" | "info" | "success" | "warn" | "danger";

const SANDBOX_STATE_TONE: Record<SandboxLeaseSandboxState, ChipTone> = {
  requested: "info",
  provisioning: "info",
  running: "success",
  collecting: "info",
  cleanup: "warn",
  expired: "neutral",
  failed: "danger",
};

const LEASE_STATUS_TONE: Record<string, ChipTone> = {
  active: "success",
  released: "neutral",
  expired: "neutral",
  failed: "danger",
  retained: "warn",
};

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function lifecycleChipFor(lease: SandboxLeaseReadModel): SandboxLifecycleChip {
  if (lease.sandboxState) {
    return {
      kind: "sandbox-state",
      state: lease.sandboxState,
      label: titleCase(lease.sandboxState),
      tone: SANDBOX_STATE_TONE[lease.sandboxState] ?? "neutral",
    };
  }
  if (lease.status) {
    return {
      kind: "lease-status",
      status: lease.status,
      label: titleCase(lease.status),
      tone: LEASE_STATUS_TONE[lease.status] ?? "neutral",
    };
  }
  return { kind: "unknown", label: "Unknown", tone: "warn" };
}

export interface CleanupChip {
  label: string;
  tone: ChipTone;
}

export function cleanupChipFor(lease: SandboxLeaseReadModel): CleanupChip {
  const status = lease.cleanupStatus;
  if (!status) return { label: "No cleanup state", tone: "neutral" };
  switch (status) {
    case "pending":
      return { label: "Cleanup pending", tone: "info" };
    case "success":
      return { label: "Cleanup complete", tone: "success" };
    case "failed":
      return { label: "Cleanup failed", tone: "danger" };
    default:
      return { label: titleCase(String(status)), tone: "neutral" };
  }
}

export interface ProviderChip {
  label: string;
  enabled: boolean;
  previewOnly: boolean;
  tone: ChipTone;
}

export function providerChipFor(
  providerKey: string | null,
  providerEnabled: boolean,
): ProviderChip {
  if (!providerKey) {
    return { label: "No provider", enabled: false, previewOnly: true, tone: "warn" };
  }
  // Backend keeps providers preview-only in this phase even when the flag is
  // set. We surface both the enabled flag and the preview-only chip so an
  // operator never reads "enabled" as "running real containers".
  return {
    label: providerKey,
    enabled: providerEnabled,
    previewOnly: true,
    tone: providerEnabled ? "info" : "warn",
  };
}

/**
 * Approval / release-hold chip vocabulary. The backend `/api/sandbox`
 * surface itself does not own approvals, but the dashboard cross-references
 * approvals from `/api/approvals` and exposes a release-held chip wherever
 * mutating controls would otherwise appear. Labels are stable across
 * empty/loading states so screen readers can announce them.
 */
export type ApprovalChipKind =
  | "approval-required"
  | "approval-pending"
  | "release-held"
  | "approval-not-required";

export function approvalChipLabel(kind: ApprovalChipKind): string {
  switch (kind) {
    case "approval-required":
      return "Approval required";
    case "approval-pending":
      return "Approval pending";
    case "release-held":
      return "Release held";
    case "approval-not-required":
      return "No approval needed";
  }
}

/**
 * Redaction copy. Backend mirrors `[REDACTED]` for sensitive keys. The UI
 * displays the more human-friendly "Hidden by policy" copy alongside the
 * raw sentinel so operators learn to recognize both.
 */
export const REDACTED_SENTINEL = "[REDACTED]";
export const REDACTED_DISPLAY = "Hidden by policy";

export function isRedactedValue(value: unknown): boolean {
  return typeof value === "string" && value === REDACTED_SENTINEL;
}

export function displayRedactedValue(value: unknown): string {
  if (isRedactedValue(value)) return REDACTED_DISPLAY;
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return String(value);
}
