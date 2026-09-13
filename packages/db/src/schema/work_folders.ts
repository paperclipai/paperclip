import { sql } from "drizzle-orm";
import { bigint, boolean, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { SandboxWorkFolderManifest, WorkFolderScope } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const workFolders = pgTable("work_folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  scope: text("scope").$type<WorkFolderScope>().notNull(),
  ownerId: text("owner_id").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("work_folders_owner_uq").on(t.companyId, t.scope, t.ownerId), unique("work_folders_company_id_uq").on(t.companyId, t.id)]);

export const workFiles = pgTable("work_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  folderId: uuid("folder_id").notNull(),
  path: text("path").notNull(),
  kind: text("kind").$type<"file" | "directory">().notNull().default("file"),
  objectKey: text("object_key"),
  byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
  sha256: text("sha256"),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  executable: boolean("executable").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.folderId], foreignColumns: [workFolders.companyId, workFolders.id] }).onDelete("cascade"),
  uniqueIndex("work_files_folder_path_uq").on(t.folderId, t.path).where(sql`${t.deletedAt} is null`),
  index("work_files_company_folder_idx").on(t.companyId, t.folderId),
]);

/** Content-free receipts prevent an old retry from overwriting a newer edit. */
export const workFileOperations = pgTable("work_file_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  folderId: uuid("folder_id").notNull(),
  operationId: text("operation_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.folderId], foreignColumns: [workFolders.companyId, workFolders.id] }).onDelete("cascade"),
  unique("work_file_operations_receipt_uq").on(t.folderId, t.operationId),
]);

export const taskRepositoryBindings = pgTable("task_repository_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  // Keep saved work after a project workspace is removed.
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  repoRef: text("repo_ref"),
  setupComplete: boolean("setup_complete").notNull().default(false),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  checkpointKey: text("checkpoint_key"),
  checkpointSha256: text("checkpoint_sha256"),
  checkpointAt: timestamp("checkpoint_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("task_repository_bindings_workspace_uq").on(t.companyId, t.taskId, t.workspaceId), unique("task_repository_bindings_name_uq").on(t.companyId, t.taskId, t.name)]);

export const workFolderRuns = pgTable("work_folder_runs", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  manifest: jsonb("manifest").$type<SandboxWorkFolderManifest>().notNull(),
  baselines: jsonb("baselines").$type<Record<string, Array<{ path: string; kind: "file" | "directory"; byteSize: number; sha256: string | null; executable: boolean }>>>().notNull().default({}),
  pendingOperations: jsonb("pending_operations").$type<Record<string, { id: string; signature: string }>>().notNull().default({}),
  state: text("state").$type<"starting" | "saved" | "saving" | "failed">().notNull().default("starting"),
  lastSavedAt: timestamp("last_saved_at", { withTimezone: true }),
  error: text("error"),
  refreshRequested: boolean("refresh_requested").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("work_folder_runs_company_idx").on(t.companyId)]);

/** Upload intents and deferred deletion survive uncertain commits and owner deletion. */
export const workFolderObjects = pgTable("work_folder_objects", {
  objectKey: text("object_key").primaryKey(),
  companyId: uuid("company_id").notNull(),
  folderId: uuid("folder_id"),
  repositoryBindingId: uuid("repository_binding_id"),
  provider: text("provider").notNull(),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("work_folder_objects_cleanup_idx").on(t.provider, t.deleteAfter)]);
