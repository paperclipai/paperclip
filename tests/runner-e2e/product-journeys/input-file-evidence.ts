import { createHash } from "node:crypto";

export interface InputFileFixture {
  filename: string;
  bytes: Buffer;
  expected: { reference: string; acceptedRows: number; acceptedUnits: number };
}

/** Answers exist only in the uploaded bytes, never in the task prompt. */
export function inputFileFixture(reference: string): InputFileFixture {
  const seed = createHash("sha256").update(reference).digest();
  const rows = Array.from({ length: 5 }, (_, index) => ({
    item: `item-${index + 1}`, units: seed[index]! + 1,
    decision: index === 1 || index === 4 ? "declined" : "accepted",
  }));
  return {
    filename: "order-review.csv",
    bytes: Buffer.from(`reference,item,units,decision\n${rows.map(row => `${reference},${row.item},${row.units},${row.decision}`).join("\n")}\n`),
    expected: { reference, acceptedRows: 3,
      acceptedUnits: rows.filter(row => row.decision === "accepted").reduce((sum, row) => sum + row.units, 0) },
  };
}

export function inputFileSummaryMatches(body: unknown, expected: InputFileFixture["expected"]): boolean {
  if (typeof body !== "string") return false;
  const text = body.trim();
  const json = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1] ?? text;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return Object.keys(row).sort().join(",") === "acceptedRows,acceptedUnits,reference"
      && row.reference === expected.reference && row.acceptedRows === expected.acceptedRows
      && row.acceptedUnits === expected.acceptedUnits;
  } catch { return false; }
}

export interface InputFileAttachment {
  id: string; companyId: string; issueId: string; originalFilename: string;
  originatingRunId: string | null; byteSize: number;
}

export function inputFileAttachmentMatches(attachment: InputFileAttachment | undefined,
  input: { companyId: string; issueId: string; fixture: InputFileFixture; downloaded: Buffer }): boolean {
  return Boolean(attachment?.id && attachment.companyId === input.companyId && attachment.issueId === input.issueId
    && attachment.originalFilename === input.fixture.filename && attachment.originatingRunId === null
    && attachment.byteSize === input.fixture.bytes.length && input.downloaded.equals(input.fixture.bytes));
}
