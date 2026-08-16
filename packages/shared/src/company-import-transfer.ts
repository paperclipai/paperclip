import { z } from "zod";

// Wire contract for chunked resumable company import transfers. The server
// routes validate against these schemas and the browser and CLI clients type
// their requests/responses against the inferred types, so all three sides
// share one description of the payload shapes and route paths.

/** Transfer routes relative to the companies router (`/api/companies`). */
export const COMPANY_IMPORT_TRANSFERS_ROUTE_PATH = "/import/transfers";
export const COMPANY_IMPORT_TRANSFERS_API_PATH = `/api/companies${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}`;

/**
 * Paths for one transfer, relative to the companies API root — callers prefix
 * their own mount ("/companies" in the browser client, "/api/companies" in
 * the CLI; the server registers the same shapes as express params).
 */
export function companyImportTransferPath(transferId: string): string {
  return `${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}/${encodeURIComponent(transferId)}`;
}

export function companyImportTransferPartPath(transferId: string, partIndex: number): string {
  return `${companyImportTransferPath(transferId)}/parts/${partIndex}`;
}

export function companyImportTransferPreviewPath(transferId: string): string {
  return `${companyImportTransferPath(transferId)}/preview`;
}

export function companyImportTransferApplyPath(transferId: string): string {
  return `${companyImportTransferPath(transferId)}/apply`;
}

/** Hard cap on the number of declared byte-range parts per transfer. */
export const COMPANY_IMPORT_TRANSFER_MAX_PARTS = 4096;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const companyImportTransferDeclaredPartSchema = z.object({
  index: z.number().int().min(0),
  byteSize: z.number().int().min(1),
  sha256: z
    .string()
    .regex(SHA256_HEX_RE, "sha256 must be 64 lowercase hex characters")
    .describe("sha256 of this part, 64 lowercase hex characters"),
});

/**
 * Declaration body for POST /api/companies/import/transfers: the caller's
 * existing .zip described as contiguous content-addressed byte-range parts.
 */
export const companyImportTransferDeclarationSchema = z.object({
  totalBytes: z.number().int().min(1),
  zipSha256: z
    .string()
    .regex(SHA256_HEX_RE, "sha256 must be 64 lowercase hex characters")
    .describe("sha256 of the whole .zip, 64 lowercase hex characters"),
  partSizeBytes: z.number().int().min(1),
  parts: z.array(companyImportTransferDeclaredPartSchema).min(1).max(COMPANY_IMPORT_TRANSFER_MAX_PARTS),
});

export type CompanyImportTransferDeclaredPart = z.infer<typeof companyImportTransferDeclaredPartSchema>;
export type CompanyImportTransferDeclaration = z.infer<typeof companyImportTransferDeclarationSchema>;

/** Ledger states a transfer run moves through (see company_transfer_runs). */
export type CompanyImportTransferRunStatus =
  | "pending"
  | "running"
  | "applying"
  | "completed"
  | "failed"
  | "cancelled";

/** Response of declaring (or resuming) a chunked import transfer. */
export interface CompanyImportTransferCreated {
  transferId: string;
  status: CompanyImportTransferRunStatus;
  /** True when this exact content already finished a prior apply. */
  alreadyCompleted: boolean;
  totalParts: number;
  missingParts: number[];
}

/** Response of the resume-polling GET for one transfer. */
export interface CompanyImportTransferStatus {
  transferId: string;
  status: CompanyImportTransferRunStatus;
  totalParts: number;
  completedParts: number;
  missingParts: number[];
}

/** Response of uploading one declared part. */
export interface CompanyImportTransferPartUploadResult {
  ok: true;
  index: number;
  /** True when the part was already spooled and verified by a prior upload. */
  alreadyCompleted: boolean;
}
