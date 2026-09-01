import * as React from "react";

import { Badge } from "@paperclipai/paperclip-runner/react";
import type {
  CapabilityParityStatus,
  CapabilityPrimaryDisposition,
  CapabilityRedactionChip as RedactionChipRecord,
} from "@paperclip-runner-local/capability";

import {
  DISPOSITION_LABEL,
  DISPOSITION_TONE,
  PARITY_ICON,
  PARITY_LABEL,
  PARITY_TONE,
} from "../labels.js";

/** Machine values — IDs, anchors, grants, JSON — always render monospace. */
export function Mono({ children }: { children: React.ReactNode }) {
  return <code className="pcr7-mono">{children}</code>;
}

export function DispositionBadge({ disposition }: { disposition: CapabilityPrimaryDisposition }) {
  return (
    <Badge tone={DISPOSITION_TONE[disposition]} data-testid={`disposition-${disposition}`}>
      {DISPOSITION_LABEL[disposition]}
    </Badge>
  );
}

/** Parity status is always icon + text; colour never carries it alone. */
export function ParityStatusBadge({
  status,
  testId,
}: {
  status: CapabilityParityStatus;
  testId?: string;
}) {
  return (
    <Badge tone={PARITY_TONE[status]} data-testid={testId ?? `parity-${status}`}>
      <span aria-hidden="true">{PARITY_ICON[status]}</span> {PARITY_LABEL[status]}
    </Badge>
  );
}

/**
 * Redacted values arrive pre-redacted from the mock core. The chip names the
 * rule so a reviewer can trace the redaction rather than guess at it.
 */
export function RedactionChip({ chip }: { chip: RedactionChipRecord }) {
  return (
    <span className="pcr7-redaction" data-testid="redaction-chip">
      <span aria-hidden="true">•••</span>
      <span>redacted</span>
      <Mono>{chip.rule}</Mono>
    </span>
  );
}

export function JsonBlock({ value, label }: { value: unknown; label: string }) {
  return (
    <>
      <p className="pcr-disclosure-label">{label}</p>
      <pre className="pcr-payload pcr7-json">{JSON.stringify(value, null, 2)}</pre>
    </>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="pcr7-empty" data-testid="empty-state">
      <p className="pcr7-empty-title">{title}</p>
      {children}
    </div>
  );
}

export function ClaimChips({ claims, testId }: { claims: readonly string[]; testId?: string }) {
  if (claims.length === 0) return <span className="pcr7-muted">none</span>;
  return (
    <span className="pcr7-chips" data-testid={testId}>
      {claims.map((claim) => (
        <Mono key={claim}>{claim}</Mono>
      ))}
    </span>
  );
}
