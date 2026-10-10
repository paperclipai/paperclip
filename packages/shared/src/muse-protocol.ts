import { z } from "zod";
import { paperclipQuestionSetPayloadSchema } from "./validators/issue.js";

export const MUSE_PROTOCOL_VERSION = 1 as const;
export const MUSE_ASSET_VERSION = 1 as const;
export const MUSE_PUBLIC_ROUTES = [
  { method: "GET", path: "/api/muse/v1/assets/1/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/1/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/1/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/1/instructions.md" },
  { method: "POST", path: "/api/muse/v1/pair" },
  { method: "POST", path: "/api/muse/v1/refresh" },
  { method: "GET", path: "/api/muse/v1/signal" },
  { method: "POST", path: "/api/muse/v1/commands" },
  { method: "POST", path: "/api/muse/v1/queries" },
  { method: "POST", path: "/api/muse/v1/cleanup" },
  { method: "POST", path: "/api/muse/v1/detector-cleanup" },
] as const;

/** Machine identity is never a human actor or a Dot OAuth grant. */
export interface AgentConnectionSubject {
  provider: "muse";
  companyId: string;
  agentId: string;
  bindingId: string;
  generation: number;
  authorizingUserId: string;
  credentialId: string;
}
export const MUSE_MAX_BODY_BYTES = 256 * 1024;
export const MUSE_TICKET_TTL_MS = 10 * 60_000;
export const MUSE_ACCESS_TTL_MS = 15 * 60_000;
export const MUSE_REFRESH_INACTIVITY_MS = 30 * 24 * 60 * 60_000;
export const MUSE_CLEANUP_TTL_MS = 24 * 60 * 60_000;
export const MUSE_IDLE_OPERATIONS = ["identify", "task.list", "task.search", "task.read", "task.history", "task.document.read", "task.create", "task.comment"] as const;
const id = z.uuid();
const boundedId = z.string().min(1).max(200);
// Keep these transport bounds aligned with Runner's external-provider validation.
const nativeRequestId = z.string().min(1).max(160).refine(
  (value) => !/[^A-Za-z0-9._:-]/.test(value),
  "Native request IDs must contain only ASCII letters, digits, '.', '_', ':', or '-'.",
);
const utf8Encoder = new TextEncoder();
const progressText = z.string().trim().min(1).max(12000).refine(
  (value) => utf8Encoder.encode(value).byteLength <= 12000,
  "Progress text must not exceed 12000 UTF-8 bytes.",
);
const envelope = { version: z.literal(MUSE_PROTOCOL_VERSION) };
const operation = { ...envelope, assignmentId: id, requestId: id };
export const museCommandSchema = z.discriminatedUnion("command", [
  z.object({ ...envelope, command: z.literal("challenge.confirm"), nonce: z.string().min(1).max(200), requestId: id }).strict(),
  z.object({ ...envelope, command: z.literal("work.request"), issueId: id, requestId: id }).strict(),
  z.object({ ...envelope, command: z.literal("turn.request"), prompt: z.string().trim().min(1).max(16000), requestId: id }).strict(),
  z.object({ ...envelope, command: z.literal("task.create"), requestId: id, title: z.string().trim().min(1).max(500), description: z.string().max(16000).optional(), parentId: id.optional(), projectId: id.optional() }).strict(),
  z.object({ ...envelope, command: z.literal("task.comment"), requestId: id, issueId: id, body: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ ...operation, command: z.literal("accept") }).strict(),
  z.object({ ...operation, command: z.literal("tool"), name: boundedId, arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ...operation, command: z.literal("progress"), text: progressText }).strict(),
  z.object({ ...operation, command: z.literal("finish"), result: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ...operation, command: z.literal("renew"), expiresAtUnixMs: z.number().int().positive() }).strict(),
  z.object({ ...operation, command: z.literal("request_user_input"), nativeRequestId, questionSet: paperclipQuestionSetPayloadSchema }).strict(),
  z.object({ ...operation, command: z.literal("consume_input"), nativeRequestId, inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), continuationReceiptId: id, continuationPersisted: z.literal(true) }).strict(),
]);
export const museQuerySchema = z.discriminatedUnion("query", [
  z.object({ ...envelope, query: z.literal("identify") }).strict(),
  z.object({ ...envelope, query: z.literal("mailbox"), after: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ ...envelope, query: z.literal("assignment.read"), assignmentId: id }).strict(),
  z.object({ ...envelope, query: z.literal("input.pending"), assignmentId: id, nativeRequestId }).strict(),
  z.object({ ...envelope, query: z.literal("operation.receipt"), assignmentId: id, requestId: id }).strict(),
  z.object({ ...envelope, query: z.literal("task.list"), after: id.optional() }).strict(),
  z.object({ ...envelope, query: z.literal("task.search"), text: z.string().trim().min(1).max(500), after: id.optional() }).strict(),
  z.object({ ...envelope, query: z.literal("task.read"), issueId: id }).strict(),
  z.object({ ...envelope, query: z.literal("task.history"), issueId: id }).strict(),
  z.object({ ...envelope, query: z.literal("task.document.read"), issueId: id, key: z.string().min(1).max(100) }).strict(),
]);
export const musePairSchema = z.object({ ...envelope, ticket: z.string().min(20).max(200), clientVersion: z.literal("1") }).strict();
export const museRefreshSchema = z.object({ ...envelope, refreshToken: z.string().min(20).max(200) }).strict();
export const museStopBoundarySchema = z.object({ bindingId: id, generation: z.number().int().positive(), assignmentId: id, runId: id,
  turnId: boundedId, assignmentRevision: z.number().int().positive(), stopNonce: id, operationBoundary: z.string().max(200).nullable() }).strict();
export const museCleanupSchema = z.discriminatedUnion("command", [
  z.object({ ...envelope, command: z.literal("control.inspect") }).strict(),
  z.object({ ...envelope, command: z.literal("worker.quiescent"), requestId: id, boundary: museStopBoundarySchema }).strict(),
]);
export const museDetectorCleanupSchema = z.union([
  z.object({ ...envelope, requestId: id, bindingId: id, generation: z.number().int().positive(), detectorRemoved: z.literal(true) }).strict(),
  z.object({ ...envelope, requestId: id, bindingId: id, generation: z.number().int().positive(), detectorRemovalRequested: z.literal(true) }).strict(),
]);
export type MuseCommand = z.infer<typeof museCommandSchema>;
export type MuseQuery = z.infer<typeof museQuerySchema>;
export type MuseStopBoundary = z.infer<typeof museStopBoundarySchema>;
export interface MuseCredentials {
  version: 1; bindingId: string; generation: number; companyId: string; agentId: string;
  accessToken: string; accessExpiresAt: string; refreshToken: string;
  refreshExpiresAt: string; signalToken: string; cleanupToken: string; detectorCleanupToken: string;
}
