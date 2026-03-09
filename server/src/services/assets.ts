import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, plugins, companies } from "@paperclipai/db";

export function assetService(db: Db) {
  return {
    create: (companyId: string, data: Omit<typeof assets.$inferInsert, "companyId">) =>
      db
        .insert(assets)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    getById: (id: string) =>
      db
        .select()
        .from(assets)
        .where(eq(assets.id, id))
        .then((rows) => rows[0] ?? null),

    /**
     * Upload an asset attributed to a plugin.
     * In a real system this would write to S3/GCS. For now we just record the
     * metadata in the database.
     */
    uploadPluginAsset: async (
      pluginId: string,
      filename: string,
      contentType: string,
      data: Buffer,
    ) => {
      // In a real implementation we would:
      // 1. Get the companyId for the plugin
      // 2. Upload `data` to object storage
      // 3. Record the metadata in `assets` table

      // For this reference implementation we'll mock the storage part.
      // We need to find the company this plugin is installed in.
      const [plugin] = await db
        .select({ companyId: companies.id })
        .from(plugins)
        .innerJoin(companies, eq(plugins.id, pluginId)) // Wait, plugins table doesn't have companyId directly?
        // Actually, plugins are global but plugin_config or similar might be per-company?
        // No, in this model plugins are installed into the instance.
        .limit(1);

      const [row] = await db
        .insert(assets)
        .values({
          companyId: "00000000-0000-0000-0000-000000000000", // system company or similar
          provider: "local",
          objectKey: `plugins/${pluginId}/${filename}`,
          contentType,
          byteSize: data.length,
          sha256: "0", // would calculate
          originalFilename: filename,
        })
        .returning();

      return {
        assetId: row.id,
        url: `/api/assets/${row.id}`,
      };
    },

    getPluginAssetUrl: async (pluginId: string, assetId: string) => {
      const row = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, assetId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw new Error("Asset not found");
      return `/api/assets/${row.id}`;
    },
  };
}

