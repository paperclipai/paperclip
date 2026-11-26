import { googleWorkspaceToolTitle, isCatalogEntryOffered, type ToolCatalogEntry } from "@paperclipai/shared";

export function withoutUnavailableActions(
  ids: Iterable<string>,
  catalog: ReadonlyArray<Pick<ToolCatalogEntry, "id" | "status" | "quarantineReason">>,
): string[] {
  const unavailable = new Set(catalog.filter((entry) => !isCatalogEntryOffered(entry)).map((entry) => entry.id));
  return [...ids].filter((id) => !unavailable.has(id));
}

/**
 * Apply one permission to a set of actions in a single change.
 *
 * Every save rewrites the connection's whole enabled/ask-first set, so a
 * group control must not issue one save per action: each would start from the
 * same render and the last would overwrite the rest.
 */
export function actionPermissionMutation(
  ids: string[],
  next: "off" | "allowed" | "ask",
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
) {
  const enabled = new Set(enabledIds);
  const askFirst = new Set(askFirstIds);
  for (const id of ids) {
    if (next === "off") {
      enabled.delete(id);
      askFirst.delete(id);
    } else {
      enabled.add(id);
      if (next === "ask") askFirst.add(id);
      else askFirst.delete(id);
    }
  }
  return { enabled, askFirst };
}

export function actionLabel(entry: { toolName: string; title?: string | null }): string {
  return googleWorkspaceToolTitle(entry.toolName, entry.title) ?? entry.toolName;
}
