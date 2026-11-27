import { randomUUID } from "node:crypto";
import { toolApplications, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { pluginAppSlug } from "@paperclipai/shared";

/**
 * Give every agent of a company a plugin's legacy top-level tools, the way an
 * installation that predates plugin connectors keeps them: one connection of
 * the plugin's implicit connector, installed for the whole company.
 */
export async function grantLegacyPluginTools(db: Db, companyId: string, pluginKey: string) {
  const slug = pluginAppSlug(pluginKey, "default");
  const [application] = await db.insert(toolApplications).values({
    companyId, applicationKey: `app-gallery:${slug}:${randomUUID()}`, name: `${pluginKey} tools ${randomUUID().slice(0, 6)}`,
    type: "paperclip_plugin", status: "active", metadata: { sourceTemplateKey: slug, galleryKey: slug },
  }).returning();
  const [connection] = await db.insert(toolConnections).values({
    companyId, applicationId: application!.id, name: application!.name, uid: randomUUID(), transport: "plugin",
    authKind: "none", enabled: true, status: "active", healthStatus: "ok",
    config: { sourceTemplateKey: slug, connectionMethodKey: "default", settings: {}, legacyPluginTools: true },
  }).returning();
  await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "company", targetId: companyId });
  return connection!;
}
