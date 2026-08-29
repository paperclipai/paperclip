import { useEffect, useState } from "react";
import { loadLocalAppBrandAssets, type LocalAppBrandAssets } from "@/lib/app-brand-assets";
import { cn } from "@/lib/utils";

const TILE_COLORS = [
  "bg-(--app-logo-tile-1)",
  "bg-(--app-logo-tile-2)",
  "bg-(--app-logo-tile-3)",
  "bg-(--app-logo-tile-4)",
  "bg-(--app-logo-tile-5)",
  "bg-(--app-logo-tile-6)",
  "bg-(--app-logo-tile-7)",
  "bg-(--app-logo-tile-8)",
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length]!;
}

interface AppLogoProps {
  name: string;
  brandKey?: string | null;
  logoUrl?: string | null;
  allowRemoteFallback?: boolean;
  size?: number;
  className?: string;
}

/**
 * App icon for the gallery and connected-apps surfaces. Renders the manifest
 * favicon when available, falling back to a coloured letter tile (deterministic
 * colour per app name) when the image is missing or fails to load.
 */
export function AppLogo({
  name,
  brandKey,
  logoUrl,
  allowRemoteFallback = true,
  size = 36,
  className,
}: AppLogoProps) {
  const [failedLogoUrls, setFailedLogoUrls] = useState<ReadonlySet<string>>(() => new Set());
  const lookupKey = brandKey?.trim() || name;
  const [localAssetResult, setLocalAssetResult] = useState<{
    lookupKey: string;
    assets: LocalAppBrandAssets | null;
  } | null>(null);
  const localLookupComplete = localAssetResult?.lookupKey === lookupKey;
  const localAssets = localLookupComplete ? localAssetResult.assets : null;
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const dimension = { width: size, height: size };
  // Do not expose a remote caller URL until the local manifest has had a
  // chance to resolve this provider. Otherwise the browser requests the
  // remote asset during the first render even when a bundled mark exists.
  const resolvedLogoUrl = localLookupComplete
    ? localAssets?.light ?? (allowRemoteFallback ? logoUrl : null)
    : null;
  const lightLogoUrl = resolvedLogoUrl && !failedLogoUrls.has(resolvedLogoUrl)
    ? resolvedLogoUrl
    : null;
  const requestedDarkLogoUrl = localAssets?.dark ?? null;
  const darkLogoUrl = requestedDarkLogoUrl && !failedLogoUrls.has(requestedDarkLogoUrl)
    ? requestedDarkLogoUrl
    : null;
  const hasDistinctThemeLogos = Boolean(
    resolvedLogoUrl && requestedDarkLogoUrl && resolvedLogoUrl !== requestedDarkLogoUrl,
  );
  const fallbackLogoUrl = lightLogoUrl ?? darkLogoUrl;

  useEffect(() => {
    let active = true;
    void loadLocalAppBrandAssets(lookupKey)
      .then((assets) => {
        if (active) setLocalAssetResult({ lookupKey, assets });
      })
      .catch(() => {
        if (active) setLocalAssetResult({ lookupKey, assets: null });
      });
    return () => {
      active = false;
    };
  }, [lookupKey]);

  useEffect(() => {
    setFailedLogoUrls(new Set());
  }, [resolvedLogoUrl, localAssets?.dark]);

  const markLogoFailed = (url: string) => {
    setFailedLogoUrls((current) => new Set(current).add(url));
  };

  if (fallbackLogoUrl) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted", className)}
        style={dimension}
      >
        {hasDistinctThemeLogos ? (
          <>
            {lightLogoUrl ? (
              <img
                src={lightLogoUrl}
                alt=""
                width={size}
                height={size}
                className="h-full w-full object-contain dark:hidden"
                onError={() => markLogoFailed(lightLogoUrl)}
              />
            ) : (
              <span
                className={cn(
                  "flex h-full w-full items-center justify-center font-bold text-white dark:hidden",
                  colorFor(name),
                )}
                aria-hidden="true"
              >
                {letter}
              </span>
            )}
            {darkLogoUrl ? (
              <img
                src={darkLogoUrl}
                alt=""
                width={size}
                height={size}
                className="hidden h-full w-full object-contain dark:block"
                onError={() => markLogoFailed(darkLogoUrl)}
              />
            ) : (
              <span
                className={cn(
                  "hidden h-full w-full items-center justify-center font-bold text-white dark:flex",
                  colorFor(name),
                )}
                aria-hidden="true"
              >
                {letter}
              </span>
            )}
          </>
        ) : (
          <img
            src={fallbackLogoUrl}
            alt=""
            width={size}
            height={size}
            className="h-full w-full object-contain"
            onError={() => markLogoFailed(fallbackLogoUrl)}
          />
        )}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg font-bold text-white",
        colorFor(name),
        className,
      )}
      style={{ ...dimension, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
