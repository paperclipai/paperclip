/**
 * Whether an Apps-area route keeps a second rail beside the main navigation.
 * The marketplace pages (browse, a plugin, Review) carry their own header and
 * links, so they have none; chat setup and detail keep theirs, and the
 * developer pages keep one only while a developer tab is switched on.
 */
export function appsRouteHasRail(segments: readonly string[], developerTabs: boolean): boolean {
  const area = segments[0]?.toLowerCase();
  if (area === "tools") return developerTabs;
  if (area !== "apps") return false;
  const section = segments[1]?.toLowerCase();
  if (section === "chat") return Boolean(segments[2]);
  if (section === "advanced" || section === "gateways" || section === "connections") return developerTabs;
  return false;
}
