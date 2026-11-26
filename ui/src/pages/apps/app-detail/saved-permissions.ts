import type { ToolPolicy, ToolProfileConfiguration } from "@paperclipai/shared";
import type { InstallState } from "@/lib/tool-installs";
import type { AccessDraft } from "./types";

export function enabledCatalogIds(profile: ToolProfileConfiguration | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of profile?.entries ?? []) {
    if (entry.effect === "include" && entry.catalogEntryId) ids.add(entry.catalogEntryId);
  }
  return ids;
}

export function askFirstCatalogIds(policies: ToolPolicy[], connectionId: string): Set<string> {
  const ids = new Set<string>();
  for (const policy of policies) {
    if (policy.policyType !== "require_approval" || policy.enabled === false) continue;
    const config = (policy.config ?? {}) as { source?: unknown; connectionId?: unknown; catalogEntryId?: unknown };
    if (config.source === "app_gallery_finish" && config.connectionId === connectionId && typeof config.catalogEntryId === "string") {
      ids.add(config.catalogEntryId);
    }
  }
  return ids;
}

/**
 * Who may use this connection, read back from the app profile's bindings.
 *
 * `finishApp` replaces a profile's whole binding set, so every save from this
 * page — including an action-permission toggle — has to restate this. The
 * Permissions tab exposes the bindings as Agent access, while installs remain
 * a separate "always loaded" choice. If the profile has no bindings yet, the
 * install state remains the safest legacy fallback.
 *
 * That fallback is the important part. It used to return "all agents" for an
 * unbound profile, which turned any unrelated save into a silent company-wide
 * grant from a control the reader could not see. Installs authorize their
 * targets, so mirroring the install state is both the truthful reading and the
 * one that agrees with what the tab displays.
 */
export function accessFrom(
  profile: ToolProfileConfiguration | undefined,
  install: InstallState,
): AccessDraft {
  const bindings = profile?.bindings ?? [];
  if (bindings.some((b) => b.targetType === "company")) {
    return { mode: "all", agentIds: new Set() };
  }
  const agentIds = new Set(bindings.filter((b) => b.targetType === "agent").map((b) => b.targetId));
  if (agentIds.size > 0) return { mode: "specific", agentIds };
  return install.onAll
    ? { mode: "all", agentIds: new Set() }
    : { mode: "specific", agentIds: new Set(install.agentIds) };
}

export function accessIncludingInstalls(next: AccessDraft, install: InstallState): AccessDraft {
  if (install.onAll || next.mode === "all") {
    return { mode: "all", agentIds: new Set() };
  }
  return {
    mode: "specific",
    agentIds: new Set([...next.agentIds, ...install.agentIds]),
  };
}
