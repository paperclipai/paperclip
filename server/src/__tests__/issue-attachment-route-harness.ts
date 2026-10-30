import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import express from "express";
import { vi } from "vitest";
import type { StorageService } from "../storage/types.js";

export const mockIssueService = {
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  createAttachment: vi.fn(),
  getAttachmentById: vi.fn(),
};
export const mockCompanyService = {
  getById: vi.fn(),
};
export const mockWorkProductService = {
  createForIssue: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
};
export const mockAccessService = {
  decide: vi.fn(async () => ({
    allowed: true,
    explanation: "Allowed by test mock",
  })),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
};

export const mockLogActivity = vi.fn(async () => undefined);

export function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(),
    }),
    companySkillService: () => ({}),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

export type TestStorageService = StorageService & {
  __calls: {
    putFile?: {
      companyId: string;
      namespace: string;
      originalFilename?: string;
      contentType: string;
      body: Buffer | Readable;
      byteSize?: number;
      sha256?: string;
    };
    /** Bytes the mock actually read off the streamed body of the last putFile. */
    receivedBytes?: Buffer;
  };
};

/** Read a streamed body to completion so the mock can size and hash what arrived. */
async function drainStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export function createStorageService(
  body = Buffer.from("test"),
  options: { putFileError?: Error } = {},
): TestStorageService {
  const calls: TestStorageService["__calls"] = {};
  return {
    provider: "local_disk",
    __calls: calls,
    putFile: async (input) => {
      calls.putFile = input;
      // A rejection before reading models storage validation (for example, the
      // generated object key) failing before the body stream is touched.
      if (options.putFileError) {
        throw options.putFileError;
      }
      // Consume the streamed body exactly as a real provider would, so the test
      // proves the whole file arrived rather than only that storage was called
      // with a stream argument. `body.length` is undefined for a stream.
      const received = Buffer.isBuffer(input.body)
        ? input.body
        : await drainStream(input.body);
      calls.receivedBytes = received;
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
        contentType: input.contentType,
        byteSize: received.length,
        sha256: createHash("sha256").update(received).digest("hex"),
        originalFilename: input.originalFilename,
      };
    },
    getObject: vi.fn(async (_companyId, _objectKey, options) => {
      const range = options?.range;
      const streamBody = range ? body.subarray(range.start, range.end + 1) : body;
      return {
        stream: Readable.from(streamBody),
        contentLength: streamBody.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

export async function createApp(storage: StorageService, options?: { companyIds?: string[]; source?: string }) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: options?.companyIds ?? ["company-1"],
      source: options?.source ?? "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, storage));
  app.use(errorHandler);
  return app;
}

export function makeAttachment(contentType: string, originalFilename: string) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "attachment-1",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: `issues/issue-1/${originalFilename}`,
    contentType,
    byteSize: 4,
    sha256: "sha256-sample",
    originalFilename,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdAt: now,
    updatedAt: now,
  };
}

export function parseBinaryResponse(res: IncomingMessage, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
  res.on("error", callback);
}
