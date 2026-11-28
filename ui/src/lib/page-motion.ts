/** Sections whose second path segment is a tab or an item picked beside the page, not a new page. */
const SINGLE_PAGE_SECTIONS = new Set(["inbox", "activity", "chats", "company", "settings", "skills"]);
const TAB_SEGMENTS = new Set(["all", "active", "pending", "backlog", "done", "recent"]);

/**
 * Identifies the page a route shows. The page-enter motion plays when this
 * changes, so moving between tabs of one page stays still.
 */
export function pageMotionKey(companySegments: readonly string[]): string {
  const section = companySegments[0]?.toLowerCase() ?? "";
  const item = companySegments[1]?.toLowerCase();
  if (!item || SINGLE_PAGE_SECTIONS.has(section) || TAB_SEGMENTS.has(item)) return section;
  return `${section}/${item}`;
}
