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
