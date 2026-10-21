import type { ActivityEvent } from "@paperclipai/shared";
import { ActivityRow, type ActivityRowProps } from "./ActivityRow";

/** Caller-ordered events, with the same row tokens and responsive metadata
 * priorities as task summaries. Event destinations and task hover cards remain
 * owned by ActivityRow and the shared Link; non-task events never get task IDs. */
export function ActivityList({ events, label = "Recent activity", density = "comfortable", rowClassName, ...directories }: {
  events: readonly ActivityEvent[];
  label?: string;
  density?: "comfortable" | "compact";
  rowClassName?: (event: ActivityEvent) => string | undefined;
} & Pick<ActivityRowProps, "agentMap" | "userProfileMap" | "entityNameMap" | "entityTitleMap">) {
  return <ul className="task-summary-list activity-list" aria-label={label}>
    {events.map(event => <li key={event.id}><ActivityRow {...directories} event={event} appearance="refreshed" density={density} className={rowClassName?.(event)} /></li>)}
  </ul>;
}
