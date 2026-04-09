import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * `memory_bindings` — company-scoped configuration records that point to a
 * memory provider (built-in or plugin-supplied).
 *
 * Each binding is identified by a stable `binding_key` within its company.
 * Multiple bindings can coexist per company; agents and the control plane
 * resolve the active provider by key.
 *
 * Phase 1: control-plane contract only — no built-in provider yet.
 *
 * @see doc/plans/2026-03-17-memory-service-surface-api.md §Rollout Phases
 */
export const memoryBindings = pgTable(
  "memory_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stable user-facing key for this binding, e.g. `"default"`, `"mem0-prod"`. */
    bindingKey: text("binding_key").notNull(),
    /**
     * Identifies the memory provider implementation.
     * For plugin-supplied providers, this is the plugin's `pluginKey`.
     * Reserved built-in keys: `"local-markdown"`.
     */
    providerKey: text("provider_key").notNull(),
    /**
     * Optional reference to the installed plugin that supplies this provider.
     * Null for built-in providers.
     */
    pluginId: uuid("plugin_id"),
    /** Human-readable label for display in the UI. */
    displayName: text("display_name"),
    /** Provider-specific configuration (API keys, endpoints, index names, etc.). */
    configJson: jsonb("config_json"),
    /** Whether this binding is currently active and eligible for auto-routing. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One binding key per company. */
    uniqueKey: unique("memory_bindings_company_key_idx").on(table.companyId, table.bindingKey),
    companyIdx: index("memory_bindings_company_idx").on(table.companyId),
  }),
);

/**
 * `memory_binding_targets` — maps a binding to specific agents (or, in future
 * phases, projects) that should use it instead of the company default.
 *
 * A company-level target row (`target_type = "company"`) marks the default
 * binding for all agents in that company.
 */
export const memoryBindingTargets = pgTable(
  "memory_binding_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    /** Discriminator: `"company"` for default, `"agent"` for agent overrides. */
    targetType: text("target_type").notNull(),
    /**
     * UUID of the target entity.
     * - `"company"`: `companies.id`
     * - `"agent"`: `agents.id`
     */
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One binding per (binding, targetType, targetId) tuple. */
    uniqueTarget: unique("memory_binding_targets_unique_idx").on(
      table.bindingId,
      table.targetType,
      table.targetId,
    ),
    bindingIdx: index("memory_binding_targets_binding_idx").on(table.bindingId),
    targetIdx: index("memory_binding_targets_target_idx").on(table.targetType, table.targetId),
  }),
);
