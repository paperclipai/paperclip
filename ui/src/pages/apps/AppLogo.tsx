import { useState } from "react";
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
  logoUrl?: string | null;
  size?: number;
  className?: string;
}

/**
 * App icon for the gallery and connected-apps surfaces. Renders the manifest
 * favicon when available, falling back to a coloured letter tile (deterministic
 * colour per app name) when the image is missing or fails to load.
 */
export function AppLogo({ name, logoUrl, size = 36, className }: AppLogoProps) {
  const [failed, setFailed] = useState(false);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const dimension = { width: size, height: size };

  if (logoUrl && !failed) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted", className)}
        style={dimension}
      >
        <img
          src={logoUrl}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
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
