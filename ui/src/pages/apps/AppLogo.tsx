import { useState } from "react";
import { cn } from "@/lib/utils";

const TILE_COLORS = [
  "bg-[#FF4F00]",
  "bg-[#24292f]",
  "bg-[#4A154B]",
  "bg-[#0f172a]",
  "bg-[#5E6AD2]",
  "bg-[#1a73e8]",
  "bg-[#0f9d58]",
  "bg-[#ea4335]",
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
