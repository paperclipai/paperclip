import {
  redactEventPayloadWithMetadata,
  redactSensitiveText,
  redactSensitiveTextWithMetadata,
} from "./redaction.js";

export const TRANSCRIPT_QUARANTINE_MARKER =
  "[paperclip: credential-shaped transcript content quarantined]";
export const TRANSCRIPT_CREDENTIAL_DETECTOR_VERSION = 1;

export type TranscriptSecurityBoundary =
  | "run_event"
  | "run_log"
  | "run_summary"
  | "diagnostic_render";

export interface TranscriptSecurityMetadata {
  disposition: "quarantined" | "redacted";
  boundary: TranscriptSecurityBoundary;
  detectorVersion: number;
  matchCount: number;
}

export interface TranscriptSecurityResult<T> {
  value: T;
  metadata: TranscriptSecurityMetadata | null;
}

export function transcriptCredentialQuarantineEnabled(env = process.env) {
  return env.PAPERCLIP_TRANSCRIPT_CREDENTIAL_QUARANTINE?.trim().toLowerCase() !== "false";
}

function metadataFor(
  boundary: TranscriptSecurityBoundary,
  matchCount: number,
  quarantineEnabled: boolean,
): TranscriptSecurityMetadata | null {
  if (matchCount <= 0) return null;
  return {
    disposition: quarantineEnabled ? "quarantined" : "redacted",
    boundary,
    detectorVersion: TRANSCRIPT_CREDENTIAL_DETECTOR_VERSION,
    matchCount,
  };
}

export function secureTranscriptText(
  input: string,
  boundary: TranscriptSecurityBoundary,
  options?: { quarantineEnabled?: boolean },
): TranscriptSecurityResult<string> {
  const result = redactSensitiveTextWithMetadata(input);
  const metadata = metadataFor(
    boundary,
    result.matchCount,
    options?.quarantineEnabled ?? transcriptCredentialQuarantineEnabled(),
  );
  if (!metadata || metadata.disposition === "redacted") {
    return { value: result.value, metadata };
  }
  return {
    value: `${TRANSCRIPT_QUARANTINE_MARKER}\n${result.value}`,
    metadata,
  };
}

export function secureTranscriptPayload(
  input: Record<string, unknown> | null,
  boundary: TranscriptSecurityBoundary,
  options?: { quarantineEnabled?: boolean },
): TranscriptSecurityResult<Record<string, unknown> | null> {
  const result = redactEventPayloadWithMetadata(input);
  const metadata = metadataFor(
    boundary,
    result.matchCount,
    options?.quarantineEnabled ?? transcriptCredentialQuarantineEnabled(),
  );
  if (!metadata || !result.value || metadata.disposition === "redacted") {
    return { value: result.value, metadata };
  }
  return {
    value: {
      ...result.value,
      _paperclipTranscriptSecurity: {
        ...metadata,
        marker: TRANSCRIPT_QUARANTINE_MARKER,
      },
    },
    metadata,
  };
}

export function redactTranscriptDiagnosticValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactTranscriptDiagnosticValue(entry)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return redactEventPayloadWithMetadata(value as Record<string, unknown>).value as T;
}
