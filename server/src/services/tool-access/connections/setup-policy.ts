import { getAppDefinitionForApplicationKey, isConnectorFeatureEnabled } from "@paperclipai/shared";
import { isMemoryConnectorId } from "@paperclipai/shared";
import { instanceSettingsService } from "../../instance-settings.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolApplications, toolConnections } from "@paperclipai/db";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../../../errors.js";
import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE } from "@paperclipai/shared";

export function assertSupportedConnection(connection: typeof toolConnections.$inferSelect) {
  if (isRetiredComposioConnection(connection)) {
    throw unprocessable(RETIRED_COMPOSIO_MESSAGE, { code: "composio_broker_retired" });
  }
}

export function connectionSetupApp(applicationKey: unknown, sourceTemplateKey: unknown) {
  return applicationKey != null ? getAppDefinitionForApplicationKey(applicationKey)
    : typeof sourceTemplateKey === "string" ? getConnectableAppDefinition(sourceTemplateKey) : null;
}

export function createConnectionSetupPolicy(db: Db) {
  async function assertExperimentalConnectorSetupEnabled(provider: unknown, existing = false) {
    const app = typeof provider === "string" ? getConnectableAppDefinition(provider) : null;
    if (!app?.experimentalFeatureKey && (existing || !isMemoryConnectorId(provider))) return;
    const settings = await instanceSettingsService(db).getExperimental();
    if (app && !isConnectorFeatureEnabled(app, settings)) {
      throw forbidden(`${app.name} is unavailable on this instance`, { code: "connector_disabled" });
    }
    if (!existing && isMemoryConnectorId(provider) && !settings.enableMemoryConnectors) {
      throw forbidden("Enable memory connectors in Settings → Experimental to set up this connection", { code: "memory_connectors_disabled" });
    }
  }

  async function assertConnectorConnectionSetupEnabled(connection: { config?: Record<string, unknown>; transportConfig?: Record<string, unknown>; applicationId?: string; companyId?: string; status?: string }, applicationKey?: unknown) {
    let resolvedApplicationKey = applicationKey;
    if (resolvedApplicationKey == null && connection.applicationId && connection.companyId) {
      const [application] = await db.select({ applicationKey: toolApplications.applicationKey })
        .from(toolApplications).where(and(eq(toolApplications.id, connection.applicationId),
          eq(toolApplications.companyId, connection.companyId))).limit(1);
      resolvedApplicationKey = application?.applicationKey;
    }
    const marker = connection.config?.sourceTemplateKey ?? connection.transportConfig?.sourceTemplateKey;
    const app = connectionSetupApp(resolvedApplicationKey, marker);
    if (app) await assertExperimentalConnectorSetupEnabled(app.slug, connection.status !== "draft");
  }
  return { assertExperimentalConnectorSetupEnabled, assertConnectorConnectionSetupEnabled };
}
export type ConnectionSetupPolicy = ReturnType<typeof createConnectionSetupPolicy>;
