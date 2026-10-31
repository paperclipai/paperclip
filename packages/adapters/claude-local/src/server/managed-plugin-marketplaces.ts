import fs from "node:fs/promises";
import path from "node:path";

/** Keep only public GitHub repository identities, never source URLs or credentials. */
export function selectManagedPluginMarketplaces(
  raw: Record<string, unknown> | null,
  pluginIds: string[],
): Record<string, { repo: string; plugins: string[] }> {
  const result: Record<string, { repo: string; plugins: string[] }> = Object.create(null);
  for (const id of pluginIds) {
    const [plugin, marketplace, extra] = id.split("@");
    if (extra || !plugin || !marketplace ||
      !/^[a-zA-Z0-9_-]+$/.test(plugin) || !/^[a-zA-Z0-9_-]+$/.test(marketplace)) continue;
    const entry = raw?.[marketplace];
    if (!entry || typeof entry !== "object" || !("source" in entry)) continue;
    const source = entry.source;
    if (!source || typeof source !== "object" || !("source" in source) ||
      source.source !== "github" || !("repo" in source) || typeof source.repo !== "string" ||
      !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source.repo)) continue;
    const selected = result[marketplace] ??= { repo: source.repo, plugins: [] };
    if (!selected.plugins.includes(plugin)) selected.plugins.push(plugin);
  }
  return result;
}

export async function writeManagedPluginMarketplaces(
  stagingDir: string,
  snapshotDir: string,
  marketplaces: ReturnType<typeof selectManagedPluginMarketplaces>,
): Promise<void> {
  const registry: Record<string, unknown> = Object.create(null);
  for (const [name, { repo, plugins }] of Object.entries(marketplaces)) {
    const relativeDir = path.join("plugins", "marketplaces", name);
    const manifestDir = path.join(stagingDir, relativeDir, ".claude-plugin");
    await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
    // Claude resolves installed payloads from installed_plugins.json, but still
    // requires a marketplace catalog. Do not copy marketplace hooks or settings.
    await fs.writeFile(path.join(manifestDir, "marketplace.json"), JSON.stringify({
      name,
      owner: { name: "Paperclip profile import" },
      plugins: plugins.map((plugin) => ({ name: plugin, source: "./" })),
    }), { mode: 0o600 });
    registry[name] = {
      source: { source: "github", repo },
      installLocation: path.join(snapshotDir, relativeDir),
      lastUpdated: "1970-01-01T00:00:00.000Z",
    };
  }
  if (Object.keys(registry).length > 0) {
    await fs.writeFile(path.join(stagingDir, "plugins", "known_marketplaces.json"),
      JSON.stringify(registry), { mode: 0o600 });
  }
}
