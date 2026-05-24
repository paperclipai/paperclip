import type { Db } from "@paperclipai/db";

export type ParserStatus = "pending" | "parsing" | "completed" | "failed";

export type DocumentType =
  | "crew_itinerary"
  | "flight_briefing"
  | "flight_plan"
  | "weight_balance";

export interface ParseInput {
  db: Db;
  buffer: Buffer;
  documentId: string;
  metadata: {
    tripId: string;
    dutyDayId?: string | null;
    aircraftTail?: string | null;
    documentType: DocumentType;
  };
}

export interface ParseResult {
  success: boolean;
  summary?: Record<string, unknown>;
  error?: string;
}

export type DocumentParser = (input: ParseInput) => Promise<ParseResult>;

const registry = new Map<DocumentType, DocumentParser>();

export function registerDocumentType(type: DocumentType, parser: DocumentParser): void {
  registry.set(type, parser);
}

export function getParser(type: string): DocumentParser | undefined {
  return registry.get(type as DocumentType);
}

export function getRegisteredTypes(): DocumentType[] {
  return Array.from(registry.keys());
}

export function isRegisteredType(type: string): type is DocumentType {
  return registry.has(type as DocumentType);
}
