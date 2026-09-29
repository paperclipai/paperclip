export type AppBrandManifestProvider = {
  slug: string;
  provider: string;
  localAsset: string;
  darkAsset?: string;
  aliases?: string[];
};

export type AppBrandManifest = {
  schemaVersion: number;
  providers: AppBrandManifestProvider[];
};

export type LocalAppBrandAssets = {
  light: string;
  dark?: string;
};

let manifestPromise: Promise<AppBrandManifest> | null = null;

function normalizedProviderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isManifest(value: unknown): value is AppBrandManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppBrandManifest>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.providers)
    && candidate.providers.every((provider) => provider && typeof provider === "object"
      && typeof provider.slug === "string" && typeof provider.provider === "string"
      && isLocalAssetPath(provider.localAsset)
      && (provider.darkAsset === undefined || isLocalAssetPath(provider.darkAsset))
      && (provider.aliases === undefined || (Array.isArray(provider.aliases)
        && provider.aliases.every((alias) => typeof alias === "string"))));
}

function isLocalAssetPath(value: unknown): value is string {
  return typeof value === "string" && /^\/brands\/apps\/[a-z0-9-]+\.(svg|png)$/.test(value);
}

async function loadManifest(): Promise<AppBrandManifest> {
  if (!manifestPromise) {
    manifestPromise = fetch("/brands/apps/manifest.json", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`App brand manifest request failed (${response.status})`);
        const value: unknown = await response.json();
        if (!isManifest(value)) throw new Error("App brand manifest is invalid");
        return value;
      })
      .catch((error) => {
        manifestPromise = null;
        throw error;
      });
  }
  return manifestPromise;
}

export function resolveLocalAppBrandAssets(
  manifest: AppBrandManifest,
  providerName: string,
): LocalAppBrandAssets | null {
  const key = normalizedProviderKey(providerName);
  if (!key) return null;
  const provider = manifest.providers.find((candidate) =>
    candidate.slug === key || normalizedProviderKey(candidate.provider) === key
      || candidate.aliases?.some((alias) => normalizedProviderKey(alias) === key),
  );
  if (!provider || !isLocalAssetPath(provider.localAsset)) return null;
  return {
    light: provider.localAsset,
    dark: isLocalAssetPath(provider.darkAsset) ? provider.darkAsset : provider.localAsset,
  };
}

export async function loadLocalAppBrandAssets(providerName: string): Promise<LocalAppBrandAssets | null> {
  return resolveLocalAppBrandAssets(await loadManifest(), providerName);
}

export function resetAppBrandManifestCacheForTests() {
  manifestPromise = null;
}
