import {
  Crown,
  Code,
  DollarSign,
  Megaphone,
  Users,
  Terminal,
  Shield,
  PenLine,
  Scale,
  Server,
  Palette,
  Bot,
  type LucideIcon,
} from "lucide-react";
import { ROLE_LEVEL_MAP, type RoleLevel } from "@ironworksai/shared";

/**
 * Maps role template keys (normalized) to their distinctive Lucide icon.
 * Falls back to Bot for unknown roles.
 */
const ROLE_ICON_MAP: Record<string, LucideIcon> = {
  ceo: Crown,
  cto: Code,
  cmo: Megaphone,
  cfo: DollarSign,
  vphr: Users,
  compliancedirector: Scale,
  seniorengineer: Terminal,
  devopsengineer: Server,
  securityengineer: Shield,
  uxdesigner: Palette,
  contentmarketer: PenLine,
};

/**
 * Maps the broader AgentRole enum values to a default icon.
 * Used when the agent's role is a generic value (e.g. "engineer")
 * rather than a template key.
 */
const AGENT_ROLE_ICON_MAP: Record<string, LucideIcon> = {
  ceo: Crown,
  cto: Code,
  cmo: Megaphone,
  cfo: DollarSign,
  vp: Users,
  director: Scale,
  manager: Users,
  engineer: Terminal,
  designer: Palette,
  devops: Server,
  qa: Shield,
};

function normalizeRole(role: string): string {
  return role.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Get the Lucide icon component for a role template key or agent role.
 * Tries template key first (e.g. "seniorengineer"), then broad role (e.g. "engineer").
 */
export function getRoleIcon(role: string | null | undefined): LucideIcon {
  if (!role) return Bot;
  const normalized = normalizeRole(role);
  return ROLE_ICON_MAP[normalized] ?? AGENT_ROLE_ICON_MAP[normalized] ?? Bot;
}

/**
 * Get the organizational level for a role.
 * Uses the shared ROLE_LEVEL_MAP for template keys, with fallbacks for broad AgentRole values.
 */
export function getRoleLevel(role: string | null | undefined): RoleLevel {
  if (!role) return "staff";
  const normalized = normalizeRole(role);

  // Check shared map first (template keys)
  if (normalized in ROLE_LEVEL_MAP) {
    return ROLE_LEVEL_MAP[normalized];
  }

  // Fallback for broad AgentRole values
  const broadLevelMap: Record<string, RoleLevel> = {
    ceo: "executive",
    cto: "executive",
    cmo: "executive",
    cfo: "executive",
    coo: "executive",
    ciso: "executive",
    vp: "management",
    director: "management",
    manager: "management",
    engineer: "staff",
    designer: "staff",
    pm: "staff",
    qa: "staff",
    devops: "staff",
    analyst: "staff",
    specialist: "staff",
    researcher: "staff",
    general: "staff",
  };

  return broadLevelMap[normalized] ?? "staff";
}

/**
 * Returns the accent ring color class based on role level and employment type.
 * Executive roles get a gold ring, management gets blue, staff gets a subtle border ring.
 * Contractors get a dashed amber ring regardless of level.
 */
export function getAgentRingClass(
  role: string | null | undefined,
  employmentType?: string,
): string {
  if (employmentType === "contractor")
    return "ring-1 ring-dashed ring-amber-400/50";
  const level = getRoleLevel(role);
  switch (level) {
    case "executive":
      return "ring-2 ring-amber-500/40";
    case "management":
      return "ring-2 ring-blue-500/30";
    case "staff":
      return "ring-1 ring-border";
  }
}
