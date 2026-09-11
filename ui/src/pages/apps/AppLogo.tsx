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
  darkLogoUrl?: string | null;
  size?: number;
  className?: string;
}

/**
 * App icon for the gallery and connected-apps surfaces. Renders the manifest
 * official local provider mark when available, including a dark-mode variant.
 * The deterministic letter tile is reserved for runtime image failures.
 */
export function AppLogo({
  name,
  brandKey,
  logoUrl,
  darkLogoUrl,
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
  const resolvedDarkLogoUrl = localLookupComplete
    ? localAssets?.dark ?? (allowRemoteFallback ? darkLogoUrl : null)
    : null;
  const lightLogoUrlForRender = resolvedLogoUrl && !failedLogoUrls.has(resolvedLogoUrl)
    ? resolvedLogoUrl
    : null;
  const darkLogoUrlForRender = resolvedDarkLogoUrl && !failedLogoUrls.has(resolvedDarkLogoUrl)
    ? resolvedDarkLogoUrl
    : null;
  const hasDistinctThemeLogos = Boolean(
    resolvedLogoUrl && resolvedDarkLogoUrl && resolvedLogoUrl !== resolvedDarkLogoUrl,
  );
  const fallbackLogoUrl = lightLogoUrlForRender ?? darkLogoUrlForRender;

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
  }, [resolvedDarkLogoUrl, resolvedLogoUrl]);

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
            {lightLogoUrlForRender ? (
              <img
                src={lightLogoUrlForRender}
                alt=""
                width={size}
                height={size}
                className="h-full w-full object-contain p-1.5 dark:hidden"
                onError={() => markLogoFailed(lightLogoUrlForRender)}
              />
            ) : (
              <span
                className={cn(
                  "flex h-full w-full items-center justify-center text-sm font-bold text-white dark:hidden",
                  colorFor(name),
                )}
                aria-hidden="true"
              >
                {letter}
              </span>
            )}
            {darkLogoUrlForRender ? (
              <img
                src={darkLogoUrlForRender}
                alt=""
                width={size}
                height={size}
                className="hidden h-full w-full object-contain p-1.5 dark:block"
                onError={() => markLogoFailed(darkLogoUrlForRender)}
              />
            ) : (
              <span
                className={cn(
                  "hidden h-full w-full items-center justify-center text-sm font-bold text-white dark:flex",
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
            className="h-full w-full object-contain p-1.5"
            onError={() => markLogoFailed(fallbackLogoUrl)}
          />
        )}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white",
        colorFor(name),
        className,
      )}
      style={dimension}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
