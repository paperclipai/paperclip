import { z } from "zod";
import { paperclipQuestionSetPayloadSchema } from "./validators/issue.js";

export const MUSE_PROTOCOL_VERSION = 1 as const;
export const MUSE_ASSET_VERSION = 9 as const;
export const MUSE_CLIENT_VERSION = "9" as const;
export const MUSE_PUBLIC_ROUTES = [
  { method: "GET", path: "/api/muse/v1/assets/1/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/1/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/1/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/1/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/2/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/2/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/2/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/2/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/3/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/3/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/3/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/3/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/4/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/4/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/4/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/4/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/5/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/5/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/5/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/5/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/6/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/6/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/6/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/6/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/7/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/7/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/7/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/7/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/8/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/8/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/8/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/8/instructions.md" },
  { method: "GET", path: "/api/muse/v1/assets/9/manifest.json" },
  { method: "GET", path: "/api/muse/v1/assets/9/client.py" },
  { method: "GET", path: "/api/muse/v1/assets/9/detector.sh" },
  { method: "GET", path: "/api/muse/v1/assets/9/instructions.md" },
  { method: "POST", path: "/api/muse/v1/pair" },
  { method: "POST", path: "/api/muse/v1/refresh" },
  { method: "POST", path: "/api/muse/v1/oauth/register" },
  { method: "GET", path: "/api/muse/v1/oauth/authorize" },
  { method: "POST", path: "/api/muse/v1/oauth/token" },
  { method: "POST", path: "/api/muse/v1/oauth/revoke" },
  { method: "GET", path: "/api/muse/v1/oauth/metadata" },
  { method: "GET", path: "/api/muse/v1/signal" },
  { method: "POST", path: "/api/muse/v1/commands" },
  { method: "POST", path: "/api/muse/v1/queries" },
  { method: "POST", path: "/api/muse/v1/cleanup" },
  { method: "POST", path: "/api/muse/v1/detector-cleanup" },
] as const;

export const MUSE_RESOURCE_PATH = "/api/muse/v1" as const;
export const MUSE_OAUTH_PATH = "/api/muse/v1/oauth" as const;
export const MUSE_OAUTH_SCOPES = ["paperclip:agent", "offline_access"] as const;
/** Dedicated machine identity, never a board actor or Dot grant. */
interface MuseSubjectIdentity {
  provider: "muse";
  companyId: string; agentId: string; bindingId: string; generation: number;
  authorizingUserId: string; credentialId: string;
}
export type AgentConnectionSubject = MuseSubjectIdentity & (
  { credentialSource: "oauth"; grantId: string }
  | { credentialSource: "legacy"; grantId?: never }
);
export const MUSE_MAX_BODY_BYTES = 256 * 1024;
export const MUSE_TICKET_TTL_MS = 10 * 60_000;
export const MUSE_ACCESS_TTL_MS = 15 * 60_000;
export const MUSE_REFRESH_INACTIVITY_MS = 30 * 24 * 60 * 60_000;
export const MUSE_CLEANUP_TTL_MS = 24 * 60 * 60_000;
export const MUSE_IDLE_OPERATIONS = ["identify", "task.list", "task.search", "task.read", "task.history", "task.document.read", "task.create", "task.comment"] as const;
const id = z.uuid();
const boundedId = z.string().min(1).max(200);
// Runtime correlation must also be representable by the native question bridge.
// Canonical per-question/option identities retain their separate string grammar.
const nativeRequestId = z.string().min(1).max(160).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value),
  "Native request IDs must start with an ASCII letter or digit and contain only ASCII letters, digits, '.', '_', ':', or '-'.",
);
const utf8Encoder = new TextEncoder();
const nativeQuestionSet = paperclipQuestionSetPayloadSchema.refine(
  value => utf8Encoder.encode(JSON.stringify(value)).byteLength <= 196 * 1024,
  "Question sets must not exceed Runner's 196 KiB durable UTF-8 byte bound.",
).refine(
  value => value.questions.every(question => question.textValidation?.pattern === undefined),
  "Native question patterns are unsupported by the bounded question bridge.",
);
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
  z.object({ ...operation, command: z.literal("request_user_input"), nativeRequestId, questionSet: nativeQuestionSet }).strict(),
  z.object({ ...operation, command: z.literal("consume_input"), nativeRequestId, inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), continuationReceiptId: id, continuationPersisted: z.literal(true) }).strict(),
]);
export const museQuerySchema = z.discriminatedUnion("query", [
  z.object({ ...envelope, query: z.literal("identify"), clientVersion: z.enum(["2", "3", "4", "5", "6", "7", "8", MUSE_CLIENT_VERSION]).optional() }).strict(),
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
export const musePairSchema = z.object({ ...envelope, ticket: z.string().min(20).max(200), clientVersion: z.enum(["2", "3", "4", "5", "6", "7", "8", MUSE_CLIENT_VERSION]) }).strict();
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
  refreshExpiresAt: string; cleanupToken: string; detectorCleanupToken: string;
}
