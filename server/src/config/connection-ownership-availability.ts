import { readFileSync } from "node:fs";
import {
  DEFAULT_OWNERSHIP_AVAILABILITY,
  type AppDefinition,
  type ToolConnectionOwnership,
} from "@paperclipai/shared";

type ManagedOwnership = Extract<ToolConnectionOwnership, "platform_shared" | "platform_provisioned">;
type AvailabilityConfig = Record<string, Partial<Record<ManagedOwnership, boolean>>>;

const INLINE_CONFIG_ENV = "PAPERCLIP_CONNECTION_OWNERSHIP_AVAILABILITY";
const CONFIG_FILE_ENV = "PAPERCLIP_CONNECTION_OWNERSHIP_AVAILABILITY_FILE";

function parseAvailabilityConfig(raw: string | undefined): AvailabilityConfig {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const config: AvailabilityConfig = {};
    for (const [slug, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      config[slug] = {
        ...(typeof record.platform_shared === "boolean" ? { platform_shared: record.platform_shared } : {}),
        ...(typeof record.platform_provisioned === "boolean"
          ? { platform_provisioned: record.platform_provisioned }
          : {}),
      };
    }
    return config;
  } catch {
    return {};
  }
}

function loadAvailabilityConfig(): AvailabilityConfig {
  const configFile = process.env[CONFIG_FILE_ENV]?.trim();
  if (configFile) {
    try {
      return parseAvailabilityConfig(readFileSync(configFile, "utf8"));
    } catch {
      return {};
    }
  }
  return parseAvailabilityConfig(process.env[INLINE_CONFIG_ENV]);
}

export function applyConnectionOwnershipAvailability(app: AppDefinition): AppDefinition {
  const availability = {
    ...DEFAULT_OWNERSHIP_AVAILABILITY,
    ...loadAvailabilityConfig()[app.slug],
  };
  return {
    ...app,
    ownershipAvailability: availability,
    methods: app.methods.map((method) => ({
      ...method,
      ownershipModes: method.ownershipModes.filter((ownership) => availability[ownership] !== false),
    })),
  };
}
