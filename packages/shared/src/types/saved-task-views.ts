/**
 * A saved task view: a named, reusable definition of how one task collection
 * should be filtered, sorted, grouped, and displayed.
 *
 * `viewState` holds only what is needed to rebuild the view. It never holds
 * task rows — the view is re-resolved against the live task query each time it
 * is opened, so the task table remains the single source of truth.
 */
export interface SavedTaskView {
  id: string;
  companyId: string;
  /** Identifies the task collection the view belongs to, e.g. the Tasks list. */
  collectionKey: string;
  name: string;
  viewState: Record<string, unknown>;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}
