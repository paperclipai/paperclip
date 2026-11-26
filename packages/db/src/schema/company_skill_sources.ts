import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { SkillPackageInspection, SkillRepositoryPackage } from '@paperclipai/shared';
import { companies } from './companies.js';
import { companySkills } from './company_skills.js';
import { projects } from './projects.js';
import { projectWorkspaces } from './project_workspaces.js';

export const companySkillSources = pgTable('company_skill_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  repositoryId: text('repository_id'),
  repositoryUrl: text('repository_url').notNull(),
  fullName: text('full_name').notNull(),
  trackingRef: text('tracking_ref').notNull(),
  // Retain the selected identity after deletion so refresh requires repair.
  connectionId: uuid('connection_id'),
  packageMode: text('package_mode').$type<'skills' | 'repository'>().notNull().default('skills'),
  repositoryPackage: jsonb('repository_package').$type<SkillRepositoryPackage>(),
  excludedFolders: jsonb('excluded_folders').$type<string[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  // Removed project sources retain access provenance for editable copies and forks.
  removedAt: timestamp('removed_at', { withTimezone: true }),
  automaticUpdates: boolean('automatic_updates').notNull().default(true),
  importNewSkills: boolean('import_new_skills').notNull().default(false),
  accessScope: text('access_scope').$type<'company' | 'projects'>().notNull().default('company'),
  refreshUserId: text('refresh_user_id'),
  refreshAgentId: uuid('refresh_agent_id'),
  refreshLocalTrusted: boolean('refresh_local_trusted').notNull().default(false),
  refreshGrantId: uuid('refresh_grant_id'),
  nextSyncAt: timestamp('next_sync_at', { withTimezone: true }).notNull().defaultNow(),
  failureCount: integer('failure_count').notNull().default(0),
  revision: integer('revision').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastScanCommit: text('last_scan_commit'),
  lastScanTreeSha: text('last_scan_tree_sha'),
  automaticBudgetBytes: integer('automatic_budget_bytes').notNull().default(512 * 1024 * 1024),
  automaticBudgetAt: timestamp('automatic_budget_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  repositoryRef: uniqueIndex('company_skill_sources_repository_ref_idx').on(table.companyId, table.repositoryUrl, table.trackingRef).where(sql`${table.removedAt} is null`),
  repositoryIdentity: uniqueIndex('company_skill_sources_identity_ref_idx').on(table.companyId, table.repositoryId, table.trackingRef).where(sql`${table.removedAt} is null`),
}));

/** Durable attachment jobs and retained project access provenance. */
export const projectSkillSources = pgTable('project_skill_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => projectWorkspaces.id, { onDelete: 'set null' }),
  sourceId: uuid('source_id').references(() => companySkillSources.id, { onDelete: 'set null' }),
  repositoryUrl: text('repository_url').notNull(),
  trackingRef: text('tracking_ref').notNull(),
  active: boolean('active').notNull().default(true),
  status: text('status').$type<'pending' | 'ready' | 'error'>().notNull().default('pending'),
  refreshUserId: text('refresh_user_id'),
  refreshAgentId: uuid('refresh_agent_id'),
  refreshLocalTrusted: boolean('refresh_local_trusted').notNull().default(false),
  connectionId: uuid('connection_id'),
  refreshGrantId: uuid('refresh_grant_id'),
  nextSyncAt: timestamp('next_sync_at', { withTimezone: true }).notNull().defaultNow(),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  workspaceRepository: uniqueIndex('project_skill_sources_workspace_repo_ref_idx').on(table.workspaceId, table.repositoryUrl, table.trackingRef),
  sourceProject: index('project_skill_sources_source_project_idx').on(table.companyId, table.sourceId, table.projectId),
  pending: index('project_skill_sources_sync_idx').on(table.active, table.status, table.nextSyncAt),
}));
export const companySkillSourceEntries = pgTable('company_skill_source_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => companySkillSources.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  inspection: jsonb('inspection').$type<SkillPackageInspection>(),
  skillId: uuid('skill_id').references(() => companySkills.id, { onDelete: 'set null' }),
  selection: text('selection').$type<'selected' | 'excluded' | 'new'>().notNull().default('new'),
  present: boolean('present').notNull().default(true),
  error: text('error'),
}, table => ({
  sourcePath: uniqueIndex('company_skill_source_entries_source_path_idx').on(table.sourceId, table.path),
  companySkill: index('company_skill_source_entries_company_skill_idx').on(table.companyId, table.skillId),
}));

/** Sustained company credits for automatic initial imports, including failures. */
export const companySkillImportBudgets = pgTable('company_skill_import_budgets', {
  companyId: uuid('company_id').primaryKey().references(() => companies.id, { onDelete: 'cascade' }),
  availableBytes: integer('available_bytes').notNull().default(512 * 1024 * 1024),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
