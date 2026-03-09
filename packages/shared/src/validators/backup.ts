import { z } from "zod";

export const backupTriggerSourceSchema = z.enum(["manual", "scheduler"]);
export const backupOriginSchema = z.enum(["local", "imported"]);
export const backupRunStatusSchema = z.enum(["running", "succeeded", "failed"]);
export const backupRestoreStatusSchema = z.enum(["idle", "running", "succeeded", "failed"]);
export const backupIntegrityScopeSchema = z.enum(["file", "tree"]);
export const backupIntegrityStatusSchema = z.enum(["verified", "missing", "mismatch", "error", "skipped"]);
export const backupSignatureAlgorithmSchema = z.enum(["hmac-sha256"]);
export const backupSignatureStatusSchema = z.enum([
  "verified",
  "missing",
  "mismatch",
  "error",
  "unverifiable",
  "skipped",
]);
export const backupHistoryActionSchema = z.enum(["archived", "unarchived", "deleted"]);
export const backupRemoteProviderSchema = z.enum(["none", "s3"]);
export const backupRemoteUploadStatusSchema = z.enum(["uploaded", "failed"]);
export const backupRemoteSseSchema = z.enum(["none", "AES256", "aws:kms"]);
export const backupRollbackStatusSchema = z.enum(["not_needed", "running", "succeeded", "failed"]);
export const backupComponentKeySchema = z.enum([
  "database",
  "storage",
  "config",
  "env",
  "secretsKey",
  "workspaces",
]);
export const backupComponentStatusSchema = z.enum([
  "included",
  "skipped",
  "missing",
  "unsupported",
  "failed",
]);

export const backupComponentSelectionSchema = z.object({
  storage: z.boolean().default(true),
  config: z.boolean().default(true),
  env: z.boolean().default(false),
  secretsKey: z.boolean().default(false),
  workspaces: z.boolean().default(false),
});

export const backupRemoteS3SettingsSchema = z.object({
  bucket: z.string().default(""),
  region: z.string().default("us-east-1"),
  endpoint: z.string().nullable().default(null),
  prefix: z.string().default(""),
  accessKeyId: z.string().nullable().default(null),
  secretAccessKey: z.string().nullable().default(null),
  forcePathStyle: z.boolean().default(false),
  deleteFromRemoteOnDelete: z.boolean().default(false),
  serverSideEncryption: backupRemoteSseSchema.default("none"),
  kmsKeyId: z.string().nullable().default(null),
});

export const backupRemoteSettingsSchema = z
  .object({
    provider: backupRemoteProviderSchema.default("none"),
    s3: backupRemoteS3SettingsSchema.default({
      bucket: "",
      region: "us-east-1",
      endpoint: null,
      prefix: "",
      accessKeyId: null,
      secretAccessKey: null,
      forcePathStyle: false,
      deleteFromRemoteOnDelete: false,
      serverSideEncryption: "none",
      kmsKeyId: null,
    }),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "s3") return;
    if (!value.s3.bucket.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["s3", "bucket"],
        message: "S3 bucket is required when remote backup replication is enabled.",
      });
    }
    if (!value.s3.region.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["s3", "region"],
        message: "S3 region is required when remote backup replication is enabled.",
      });
    }
    const accessKeyId = value.s3.accessKeyId?.trim() || null;
    const secretAccessKey = value.s3.secretAccessKey?.trim() || null;
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["s3", accessKeyId ? "secretAccessKey" : "accessKeyId"],
        message: "Provide both S3 access key id and secret access key, or leave both empty.",
      });
    }
    if (value.s3.serverSideEncryption === "aws:kms" && !value.s3.kmsKeyId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["s3", "kmsKeyId"],
        message: "KMS key id is required when SSE mode is aws:kms.",
      });
    }
  });

export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60),
  retentionDays: z.number().int().min(1).max(3650),
  directory: z.string().min(1),
  components: backupComponentSelectionSchema,
  requireSignedBackups: z.boolean().default(false),
  remote: backupRemoteSettingsSchema.default({
    provider: "none",
    s3: {
      bucket: "",
      region: "us-east-1",
      endpoint: null,
      prefix: "",
      accessKeyId: null,
      secretAccessKey: null,
      forcePathStyle: false,
      deleteFromRemoteOnDelete: false,
      serverSideEncryption: "none",
      kmsKeyId: null,
    },
  }),
  updatedAt: z.string().datetime().nullable().default(null),
  updatedBy: z.string().nullable().default(null),
});

export const updateBackupSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  directory: z.string().min(1).optional(),
  components: backupComponentSelectionSchema.partial().optional(),
  requireSignedBackups: z.boolean().optional(),
  remote: z
    .object({
      provider: backupRemoteProviderSchema.optional(),
      s3: backupRemoteS3SettingsSchema.partial().optional(),
    })
    .optional(),
});

export const backupComponentResultSchema = z.object({
  key: backupComponentKeySchema,
  label: z.string().min(1),
  status: backupComponentStatusSchema,
  relativePath: z.string().nullable().default(null),
  absolutePath: z.string().nullable().default(null),
  sizeBytes: z.number().int().min(0).nullable().default(null),
  itemCount: z.number().int().min(0).nullable().default(null),
  notes: z.string().nullable().default(null),
});

export const backupComponentIntegritySchema = z.object({
  key: backupComponentKeySchema,
  algorithm: z.literal("sha256"),
  scope: backupIntegrityScopeSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
});

export const backupBundleIntegritySchema = z.object({
  algorithm: z.literal("sha256"),
  recordedAt: z.string().datetime(),
  bundleHash: z.string().regex(/^[a-f0-9]{64}$/i),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  components: z.array(backupComponentIntegritySchema),
});

export const backupSignatureSchema = z.object({
  algorithm: backupSignatureAlgorithmSchema,
  keyId: z.string().nullable().default(null),
  signedAt: z.string().datetime(),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const backupRemoteCopySchema = z.object({
  provider: z.literal("s3"),
  status: backupRemoteUploadStatusSchema,
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().nullable().default(null),
  key: z.string().min(1),
  sizeBytes: z.number().int().min(0).nullable().default(null),
  uploadedAt: z.string().datetime().nullable().default(null),
  etag: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});

export const backupRunSchema = z.object({
  id: z.string().min(1),
  origin: backupOriginSchema.default("local"),
  status: backupRunStatusSchema,
  triggerSource: backupTriggerSourceSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  bundleName: z.string().min(1),
  bundlePath: z.string().min(1),
  totalSizeBytes: z.number().int().min(0),
  prunedCount: z.number().int().min(0),
  error: z.string().nullable(),
  importedAt: z.string().datetime().nullable().default(null),
  importedBy: z.string().nullable().default(null),
  importSourceFilename: z.string().nullable().default(null),
  archivedAt: z.string().datetime().nullable().default(null),
  archivedBy: z.string().nullable().default(null),
  containsSensitiveData: z.boolean().default(false),
  integrity: backupBundleIntegritySchema.nullable().default(null),
  signature: backupSignatureSchema.nullable().default(null),
  remoteCopies: z.array(backupRemoteCopySchema).default([]),
  components: z.array(backupComponentResultSchema),
});

export const restoreBackupSchema = z.object({
  confirmText: z.literal("RESTORE"),
});

export const archiveBackupSchema = z.object({
  confirmText: z.literal("ARCHIVE"),
});

export const unarchiveBackupSchema = z.object({
  confirmText: z.literal("UNARCHIVE"),
});

export const deleteBackupSchema = z.object({
  confirmText: z.literal("DELETE"),
});

export const backupRollbackStateSchema = z.object({
  status: backupRollbackStatusSchema.default("not_needed"),
  checkpointBackupId: z.string().nullable().default(null),
  checkpointBundleName: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
});

export const backupRestoreStateSchema = z.object({
  status: backupRestoreStatusSchema,
  sourceBackupId: z.string().nullable().default(null),
  sourceBundleName: z.string().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  rollback: backupRollbackStateSchema.default({
    status: "not_needed",
    checkpointBackupId: null,
    checkpointBundleName: null,
    error: null,
    finishedAt: null,
  }),
  restoredComponents: z.array(backupComponentResultSchema).default([]),
});

export const backupComponentSupportSchema = z.object({
  key: backupComponentKeySchema,
  label: z.string().min(1),
  supported: z.boolean(),
  reason: z.string().nullable().default(null),
  recommended: z.boolean().default(false),
});

export const backupHistoryActionResultSchema = z.object({
  backupId: z.string().min(1),
  bundleName: z.string().min(1),
  action: backupHistoryActionSchema,
  archivedPath: z.string().nullable().default(null),
});

export const backupRestorePreviewActionSchema = z.enum(["restore", "skip"]);

export const backupRestorePreviewComponentSchema = z.object({
  key: backupComponentKeySchema,
  label: z.string().min(1),
  sourceStatus: backupComponentStatusSchema,
  action: backupRestorePreviewActionSchema,
  destinationPath: z.string().nullable().default(null),
  integrityStatus: backupIntegrityStatusSchema,
  expectedHash: z.string().nullable().default(null),
  actualHash: z.string().nullable().default(null),
  issues: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
});

export const backupSecurityOverviewSchema = z.object({
  signingConfigured: z.boolean(),
  signingKeyId: z.string().nullable().default(null),
  signingRequired: z.boolean(),
  writeBarrierMode: z.literal("pause_mutations"),
  remoteReplicationConfigured: z.boolean(),
  remoteReplicationHealthy: z.boolean().nullable(),
});

export const backupAuditEventSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  action: z.string().min(1),
  result: z.enum(["started", "succeeded", "failed", "blocked", "info"]),
  actorId: z.string().nullable().default(null),
  backupId: z.string().nullable().default(null),
  bundleName: z.string().nullable().default(null),
  details: z.record(z.unknown()).nullable().default(null),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/i).nullable().default(null),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const backupAuditSummarySchema = z.object({
  path: z.string().min(1),
  recentEvents: z.array(backupAuditEventSchema).default([]),
});

export const backupRestorePreviewSchema = z.object({
  backupId: z.string().min(1),
  bundleName: z.string().min(1),
  backupStatus: backupRunStatusSchema,
  canRestore: z.boolean(),
  checkedAt: z.string().datetime(),
  issues: z.array(z.string()).default([]),
  integrity: z.object({
    status: backupIntegrityStatusSchema,
    expectedBundleHash: z.string().nullable().default(null),
    actualBundleHash: z.string().nullable().default(null),
    issues: z.array(z.string()).default([]),
  }),
  signature: z.object({
    status: backupSignatureStatusSchema,
    keyId: z.string().nullable().default(null),
    issues: z.array(z.string()).default([]),
  }),
  components: z.array(backupRestorePreviewComponentSchema),
});

export const backupOverviewSchema = z.object({
  settings: backupSettingsSchema,
  security: backupSecurityOverviewSchema,
  audit: backupAuditSummarySchema,
  scheduler: z.object({
    running: z.boolean(),
    activeRunId: z.string().nullable(),
    activeRunStartedAt: z.string().datetime().nullable(),
    nextScheduledAt: z.string().datetime().nullable(),
    lastAutomaticRunAt: z.string().datetime().nullable(),
  }),
  restore: backupRestoreStateSchema,
  support: z.array(backupComponentSupportSchema),
  stats: z.object({
    totalSnapshots: z.number().int().min(0),
    succeededSnapshots: z.number().int().min(0),
    failedSnapshots: z.number().int().min(0),
    storedBytes: z.number().int().min(0),
  }),
  latestSuccess: backupRunSchema.nullable(),
  latestFailure: backupRunSchema.nullable(),
  backups: z.array(backupRunSchema),
});

export type BackupTriggerSource = z.infer<typeof backupTriggerSourceSchema>;
export type BackupOrigin = z.infer<typeof backupOriginSchema>;
export type BackupRunStatus = z.infer<typeof backupRunStatusSchema>;
export type BackupRestoreStatus = z.infer<typeof backupRestoreStatusSchema>;
export type BackupIntegrityScope = z.infer<typeof backupIntegrityScopeSchema>;
export type BackupIntegrityStatus = z.infer<typeof backupIntegrityStatusSchema>;
export type BackupSignatureAlgorithm = z.infer<typeof backupSignatureAlgorithmSchema>;
export type BackupSignatureStatus = z.infer<typeof backupSignatureStatusSchema>;
export type BackupHistoryAction = z.infer<typeof backupHistoryActionSchema>;
export type BackupRemoteProvider = z.infer<typeof backupRemoteProviderSchema>;
export type BackupRemoteUploadStatus = z.infer<typeof backupRemoteUploadStatusSchema>;
export type BackupRemoteSse = z.infer<typeof backupRemoteSseSchema>;
export type BackupRollbackStatus = z.infer<typeof backupRollbackStatusSchema>;
export type BackupComponentKey = z.infer<typeof backupComponentKeySchema>;
export type BackupComponentStatus = z.infer<typeof backupComponentStatusSchema>;
export type BackupComponentSelection = z.infer<typeof backupComponentSelectionSchema>;
export type BackupRemoteS3Settings = z.infer<typeof backupRemoteS3SettingsSchema>;
export type BackupRemoteSettings = z.infer<typeof backupRemoteSettingsSchema>;
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export type UpdateBackupSettings = z.infer<typeof updateBackupSettingsSchema>;
export type BackupComponentResult = z.infer<typeof backupComponentResultSchema>;
export type BackupComponentIntegrity = z.infer<typeof backupComponentIntegritySchema>;
export type BackupBundleIntegrity = z.infer<typeof backupBundleIntegritySchema>;
export type BackupSignature = z.infer<typeof backupSignatureSchema>;
export type BackupRemoteCopy = z.infer<typeof backupRemoteCopySchema>;
export type BackupRun = z.infer<typeof backupRunSchema>;
export type RestoreBackup = z.infer<typeof restoreBackupSchema>;
export type ArchiveBackup = z.infer<typeof archiveBackupSchema>;
export type UnarchiveBackup = z.infer<typeof unarchiveBackupSchema>;
export type DeleteBackup = z.infer<typeof deleteBackupSchema>;
export type BackupRollbackState = z.infer<typeof backupRollbackStateSchema>;
export type BackupRestoreState = z.infer<typeof backupRestoreStateSchema>;
export type BackupComponentSupport = z.infer<typeof backupComponentSupportSchema>;
export type BackupHistoryActionResult = z.infer<typeof backupHistoryActionResultSchema>;
export type BackupRestorePreviewAction = z.infer<typeof backupRestorePreviewActionSchema>;
export type BackupRestorePreviewComponent = z.infer<typeof backupRestorePreviewComponentSchema>;
export type BackupSecurityOverview = z.infer<typeof backupSecurityOverviewSchema>;
export type BackupAuditEvent = z.infer<typeof backupAuditEventSchema>;
export type BackupAuditSummary = z.infer<typeof backupAuditSummarySchema>;
export type BackupRestorePreview = z.infer<typeof backupRestorePreviewSchema>;
export type BackupOverview = z.infer<typeof backupOverviewSchema>;
