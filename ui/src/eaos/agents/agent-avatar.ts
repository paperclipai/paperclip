// LET-503 round-3 — Deterministic agent avatar token.
//
// Andrii's polish-pass feedback asked for a per-agent visual identity
// that is the same wherever the agent appears: Agents table, Builder
// summary, Org graph nodes, Mission owner chips, Runs actor rows.
//
// The token is a pure function of (agentId, name, role): a 2-letter
// initials string, a role-derived lucide glyph, and a deterministic
// accent color sampled from the agent id hash. No emoji, no random
// color burst — the palette is bounded to muted hues that work on the
// light-first LET-502 surface. Accessibility: every render site passes
// the agent name + role through `aria-label`; the avatar itself is
// `aria-hidden` so it never becomes the source of truth for assistive
// tech.

import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Briefcase,
  Code2,
  CompassIcon,
  Crown,
  Cog,
  FlaskConical,
  HardHat,
  Microscope,
  Palette,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  User,
} from "lucide-react";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

export type AvatarSubject =
  | { kind: "agent"; agentId: string; name: string; role: string | null | undefined }
  | { kind: "user"; userId: string; name: string | null | undefined }
  | { kind: "system" };

export interface AgentAvatarToken {
  readonly initials: string;
  readonly Glyph: LucideIcon;
  readonly accentBg: string;
  readonly accentFg: string;
  readonly accentBorder: string;
  readonly ariaLabel: string;
  readonly tone: "agent" | "user" | "system";
}

// Six muted hue tracks. Each track is two CSS colors — a soft tinted
// background (`accentBg`) and a slightly darker, accessible foreground
// (`accentFg`) — plus a faint border that holds the avatar shape on the
// light theme without competing with the page chrome.
const AVATAR_PALETTE: ReadonlyArray<{ bg: string; fg: string; border: string }> = [
  { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" }, // blue
  { bg: "#ecfdf5", fg: "#047857", border: "#a7f3d0" }, // emerald
  { bg: "#fff7ed", fg: "#b45309", border: "#fed7aa" }, // amber
  { bg: "#fdf2f8", fg: "#9d174d", border: "#fbcfe8" }, // pink
  { bg: "#f5f3ff", fg: "#6d28d9", border: "#ddd6fe" }, // violet
  { bg: "#f0fdfa", fg: "#0f766e", border: "#99f6e4" }, // teal
];

const ROLE_GLYPH: Record<string, LucideIcon> = {
  ceo: Crown,
  cto: TerminalSquare,
  cmo: Sparkles,
  cfo: Briefcase,
  security: ShieldCheck,
  pm: CompassIcon,
  engineer: Code2,
  designer: Palette,
  qa: FlaskConical,
  devops: HardHat,
  researcher: Microscope,
  general: Bot,
};

function fnv1a32(input: string): number {
  // Deterministic 32-bit FNV-1a hash. Keeps the avatar token stable for
  // the same agent across surfaces and reviewer captures, without
  // pulling in a crypto dep just for a hue index.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function paletteFor(seed: string): { bg: string; fg: string; border: string } {
  const idx = fnv1a32(seed) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx]!;
}

function initialsFor(name: string | null | undefined, fallback: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return fallback.slice(0, 2).toUpperCase();
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function getAgentAvatarToken(subject: AvatarSubject): AgentAvatarToken {
  if (subject.kind === "system") {
    return {
      initials: "··",
      Glyph: Cog,
      accentBg: "#f3f4f6",
      accentFg: "#374151",
      accentBorder: "#e5e7eb",
      ariaLabel: "System actor",
      tone: "system",
    };
  }
  if (subject.kind === "user") {
    const fallbackSeed = subject.userId || subject.name || "user";
    const palette = paletteFor(fallbackSeed);
    return {
      initials: initialsFor(subject.name, "U"),
      Glyph: User,
      accentBg: palette.bg,
      accentFg: palette.fg,
      accentBorder: palette.border,
      ariaLabel: subject.name ? `Teammate ${subject.name}` : "Human teammate",
      tone: "user",
    };
  }
  const palette = paletteFor(subject.agentId || subject.name || "agent");
  const role = (subject.role ?? "").toLowerCase();
  const Glyph = ROLE_GLYPH[role] ?? Bot;
  return {
    initials: initialsFor(subject.name, "AG"),
    Glyph,
    accentBg: palette.bg,
    accentFg: palette.fg,
    accentBorder: palette.border,
    ariaLabel: subject.name
      ? role
        ? `Agent ${subject.name} (${role})`
        : `Agent ${subject.name}`
      : "Agent",
    tone: "agent",
  };
}

export const AVATAR_DIAMETER: Record<AvatarSize, number> = {
  xs: 16,
  sm: 22,
  md: 28,
  lg: 40,
};

export const AVATAR_GLYPH_PX: Record<AvatarSize, number> = {
  xs: 9,
  sm: 12,
  md: 14,
  lg: 18,
};

export const AVATAR_INITIALS_FONT_PX: Record<AvatarSize, number> = {
  xs: 8,
  sm: 10,
  md: 11,
  lg: 14,
};
