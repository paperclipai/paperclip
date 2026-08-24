/**
 * Known subscription feature keys.
 *
 * Each value identifies a gated capability.  Tiers declare which features
 * they include in their `features` JSONB array (string[]).
 *
 * Naming convention: `<area>_<feature>` — short, kebab-case, unambiguous.
 * Adding a key here does NOT automatically gate anything; it just makes
 * the constant importable by both server and UI.
 */
export const FEATURE_KEYS = {
  /** Install custom plugins from the marketplace into the company board. */
  CUSTOM_PLUGINS: "custom_plugins" as const,
  /** Create and run advanced AI agents (beyond the free-agent limit). */
  ADVANCED_AGENTS: "advanced_agents" as const,
  /** Retained audit-log export and search. */
  AUDIT_LOGS: "audit_logs" as const,
  /** Direct REST API access (board-level API keys). */
  API_ACCESS: "api_access" as const,
  /** Priority support SLA with guaranteed response times. */
  PRIORITY_SUPPORT: "priority_support" as const,
  /** Extended per-company storage beyond the base tier limit. */
  EXTENDED_STORAGE: "extended_storage" as const,
  /** SAML/SSO authentication. */
  SSO: "sso" as const,
  /** Custom role definitions beyond owner/admin/viewer. */
  CUSTOM_ROLES: "custom_roles" as const,
  /** Advanced analytics dashboard and reporting. */
  ADVANCED_REPORTING: "advanced_reporting" as const,
  /** Unlimited seats (board members). */
  UNLIMITED_SEATS: "unlimited_seats" as const,
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

/**
 * Feature keys that are always available to every company,
 * regardless of subscription status.  These are "free" features.
 */
export const FREE_FEATURES: readonly FeatureKey[] = [
  FEATURE_KEYS.CUSTOM_PLUGINS,
  // Add free-tier feature keys here as needed.
];

/**
 * Subscription status values that allow paid-feature access.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;
export type ActiveSubscriptionStatus = (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number];
