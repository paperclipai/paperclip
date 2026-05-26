import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import {
  adapterReadinessProbes,
  agents,
  companyOnboardingSetups,
  companySecrets,
  pluginCompanySettings,
  plugins,
  type Db,
} from "@paperclipai/db";
import {
  onboardingSetupStateSchema,
  type OnboardingSetupItem,
  type OnboardingSetupState,
} from "@paperclipai/shared";

export const DEFAULT_ONBOARDING_SETUP_ITEMS: OnboardingSetupItem[] = [
  {
    key: "local_auth",
    label: "Confirm or reuse Codex, Claude, and Antigravity OAuth sessions",
    status: "pending",
    href: "/instance/settings/adapters",
  },
  {
    key: "optional_secrets",
    label: "Add project secrets only when the starter audit identifies a concrete need",
    status: "deferred",
    href: "/company/settings/secrets",
  },
  {
    key: "mcps",
    label: "Configure MCPs and external tool adapters after the codebase audit",
    status: "deferred",
    href: "/instance/settings/adapters",
  },
];

const LOCAL_AUTH_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "agy_local"]);

function toReadModel(row: typeof companyOnboardingSetups.$inferSelect): OnboardingSetupState {
  return onboardingSetupStateSchema.parse({
    id: row.id,
    companyId: row.companyId,
    starterIssueId: row.starterIssueId,
    status: row.status,
    source: row.source,
    items: row.items,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function resolveSetupStatus(
  items: OnboardingSetupItem[],
  existingStatus: OnboardingSetupState["status"],
  options: { preserveDismissed?: boolean } = {},
): OnboardingSetupState["status"] {
  if (options.preserveDismissed && existingStatus === "dismissed") return "dismissed";
  return items.length > 0 && items.every((item) => item.status === "completed") ? "completed" : "pending";
}

export function onboardingSetupStateService(db: Db) {
  async function getByCompanyId(companyId: string) {
    const [row] = await db
      .select()
      .from(companyOnboardingSetups)
      .where(eq(companyOnboardingSetups.companyId, companyId))
      .limit(1);
    return row ? toReadModel(row) : null;
  }

  async function persistItems(
    existing: OnboardingSetupState,
    items: OnboardingSetupItem[],
    options: { preserveDismissed?: boolean } = {},
  ) {
    const status = resolveSetupStatus(items, existing.status, options);
    const now = new Date();
    const [row] = await db
      .update(companyOnboardingSetups)
      .set({
        items,
        status,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
      })
      .where(eq(companyOnboardingSetups.companyId, existing.companyId))
      .returning();
    return row ? toReadModel(row) : null;
  }

  return {
    async createPending(input: {
      companyId: string;
      starterIssueId: string;
      now?: Date;
    }) {
      const now = input.now ?? new Date();
      const [row] = await db
        .insert(companyOnboardingSetups)
        .values({
          companyId: input.companyId,
          starterIssueId: input.starterIssueId,
          status: "pending",
          source: "first_run",
          items: DEFAULT_ONBOARDING_SETUP_ITEMS,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toReadModel(row);
    },

    getByCompanyId,

    async updateStatus(companyId: string, status: "completed" | "dismissed") {
      const now = new Date();
      const [row] = await db
        .update(companyOnboardingSetups)
        .set({
          status,
          completedAt: status === "completed" ? now : null,
          updatedAt: now,
        })
        .where(eq(companyOnboardingSetups.companyId, companyId))
        .returning();
      return row ? toReadModel(row) : null;
    },

    async updateItemStatus(
      companyId: string,
      itemKey: string,
      itemStatus: OnboardingSetupItem["status"],
    ) {
      const existing = await getByCompanyId(companyId);
      if (!existing) return null;

      const items = existing.items.map((item) =>
        item.key === itemKey ? { ...item, status: itemStatus } : item,
      );
      if (!items.some((item) => item.key === itemKey)) return null;

      return persistItems(existing, items);
    },

    async refreshFromEvidence(companyId: string) {
      const existing = await getByCompanyId(companyId);
      if (!existing) return null;

      const now = new Date();
      const [companyAgents, readinessRows, activeSecrets, readyToolPlugins] = await Promise.all([
        db
          .select({
            id: agents.id,
            adapterType: agents.adapterType,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        db
          .select({
            agentId: adapterReadinessProbes.agentId,
            basicReady: adapterReadinessProbes.basicReady,
          })
          .from(adapterReadinessProbes)
          .where(and(
            eq(adapterReadinessProbes.companyId, companyId),
            or(isNull(adapterReadinessProbes.expiresAt), gt(adapterReadinessProbes.expiresAt, now)),
          ))
          .orderBy(desc(adapterReadinessProbes.createdAt)),
        db
          .select({ id: companySecrets.id })
          .from(companySecrets)
          .where(and(eq(companySecrets.companyId, companyId), ne(companySecrets.status, "deleted")))
          .limit(1),
        db
          .select({
            manifestJson: plugins.manifestJson,
            companyEnabled: pluginCompanySettings.enabled,
          })
          .from(plugins)
          .leftJoin(
            pluginCompanySettings,
            and(
              eq(pluginCompanySettings.pluginId, plugins.id),
              eq(pluginCompanySettings.companyId, companyId),
            ),
          )
          .where(eq(plugins.status, "ready")),
      ]);

      const latestReadinessByAgent = new Map<string, { basicReady: boolean }>();
      for (const row of readinessRows) {
        if (!latestReadinessByAgent.has(row.agentId)) {
          latestReadinessByAgent.set(row.agentId, row);
        }
      }

      const localAgents = companyAgents.filter((agent) => LOCAL_AUTH_ADAPTER_TYPES.has(agent.adapterType));
      const localAuthComplete =
        localAgents.length > 0 &&
        localAgents.every((agent) => latestReadinessByAgent.get(agent.id)?.basicReady === true);
      const optionalSecretsComplete = activeSecrets.length > 0;
      const mcpToolsComplete = readyToolPlugins.some((row) =>
        row.companyEnabled !== false &&
        Array.isArray(row.manifestJson.tools) &&
        row.manifestJson.tools.length > 0,
      );

      const items = existing.items.map((item) => {
        if (item.key === "local_auth" && localAuthComplete) {
          return { ...item, status: "completed" } satisfies OnboardingSetupItem;
        }
        if (item.key === "optional_secrets" && optionalSecretsComplete) {
          return { ...item, status: "completed" } satisfies OnboardingSetupItem;
        }
        if (item.key === "mcps" && mcpToolsComplete) {
          return { ...item, status: "completed" } satisfies OnboardingSetupItem;
        }
        return item;
      });

      return persistItems(existing, items, { preserveDismissed: true });
    },
  };
}

export type OnboardingSetupStateService = ReturnType<typeof onboardingSetupStateService>;
