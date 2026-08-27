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
  size?: number;
  className?: string;
}

/**
 * App icon for the gallery and connected-apps surfaces. Renders the manifest
 * favicon when available, falling back to a coloured letter tile (deterministic
 * colour per app name) when the image is missing or fails to load.
 */
export function AppLogo({ name, brandKey, logoUrl, size = 36, className }: AppLogoProps) {
  const [failed, setFailed] = useState(false);
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
  const resolvedLogoUrl = localLookupComplete ? localAssets?.light ?? logoUrl : null;

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
    setFailed(false);
  }, [resolvedLogoUrl, localAssets?.dark]);

  if (resolvedLogoUrl && !failed) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted", className)}
        style={dimension}
      >
        {localAssets?.dark ? (
          <>
            <img
              src={resolvedLogoUrl}
              alt=""
              width={size}
              height={size}
              className="h-full w-full object-contain dark:hidden"
              onError={() => setFailed(true)}
            />
            <img
              src={localAssets.dark}
              alt=""
              width={size}
              height={size}
              className="hidden h-full w-full object-contain dark:block"
              onError={() => setFailed(true)}
            />
          </>
        ) : (
          <img
            src={resolvedLogoUrl}
            alt=""
            width={size}
            height={size}
            className="h-full w-full object-contain"
            onError={() => setFailed(true)}
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
