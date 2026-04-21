export type FindingType =
  | "EMAIL"
  | "PHONE"
  | "IBAN"
  | "BIC"
  | "UST_ID"
  | "STEUERNUMMER"
  | "PLZ"
  | "URL"
  | "PERSON"
  | "FIRMA"
  | "ORT"
  | "GESCHAEFTSGEHEIMNIS"
  | "ART_9";

export type Confidence = "low" | "medium" | "high";

export interface Finding {
  type: FindingType;
  value: string;
  start: number;
  end: number;
  confidence: Confidence;
  source: "regex" | "llm";
}

export interface MappingEntry {
  pseudonym: string;
  plaintext: string;
  type: FindingType;
}

export interface AnonymizeRequest {
  text: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
}

export interface AnonymizeResult {
  mappingId: string;
  anonymizedText: string;
  findings: Array<{ type: FindingType; count: number; confidence: Confidence }>;
  warnings: string[];
}

export type AnonymizeBlockedReason = "dpo_unavailable" | "art_9_data_detected";

export interface AnonymizeBlocked {
  blocked: true;
  reason: AnonymizeBlockedReason;
}

export type AnonymizeResponse = AnonymizeResult | AnonymizeBlocked;

export interface DeanonymizeRequest {
  mappingId: string;
  text: string;
}

export interface DeanonymizeResult {
  text: string;
}

export interface AuditEntry {
  ts: string;
  agent: string;
  targetLlm: string;
  tenantId: string;
  promptHash: string;
  findings: Record<string, number>;
  blocked: boolean;
  blockedReason?: string;
}
