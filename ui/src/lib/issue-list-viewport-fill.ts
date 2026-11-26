/**
 * Decides whether a task list that cannot scroll may ask for another server
 * page by itself.
 *
 * The latch remembers the loaded issue set that the last automatic fill tried
 * to extend. A fill that succeeds changes the set and allows the next fill, so
 * a sparse filtered list keeps loading until it can scroll or the server has
 * no more pages. A fill that fails keeps the set, so it does not retry in a
 * loop.
 */
export function claimViewportFill<T>(latch: { current: T | null }, loadedIssues: T): boolean {
  if (latch.current === loadedIssues) return false;
  latch.current = loadedIssues;
  return true;
}
