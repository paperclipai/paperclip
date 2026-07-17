import {
  redactEventPayloadWithMetadata,
  redactSensitiveText,
  redactSensitiveTextWithMetadata,
  type CredentialRedactionResult,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactTranscriptStrings(value: unknown): CredentialRedactionResult<unknown> {
  if (typeof value === "string") return redactSensitiveTextWithMetadata(value);
  if (Array.isArray(value)) {
    const entries = value.map(redactTranscriptStrings);
    return {
      value: entries.map((entry) => entry.value),
      matchCount: entries.reduce((total, entry) => total + entry.matchCount, 0),
    };
  }
  if (!isPlainObject(value)) return { value, matchCount: 0 };

  const entries = Object.entries(value).map(([key, entry]) => [
    key,
    redactTranscriptStrings(entry),
  ] as const);
  return {
    value: Object.fromEntries(entries.map(([key, entry]) => [key, entry.value])),
    matchCount: entries.reduce((total, [, entry]) => total + entry.matchCount, 0),
  };
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
  const keyResult = redactEventPayloadWithMetadata(input);
  const textResult = redactTranscriptStrings(keyResult.value);
  const result = {
    value: textResult.value as Record<string, unknown> | null,
    matchCount: keyResult.matchCount + textResult.matchCount,
  };
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
  if (!isPlainObject(value)) return value;
  const keyRedacted = redactEventPayloadWithMetadata(value).value;
  return redactTranscriptStrings(keyRedacted).value as T;
}
