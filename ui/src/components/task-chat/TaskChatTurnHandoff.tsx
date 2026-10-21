import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { parseCssTimeMs } from "./motion-tokens";

/** Keep the answer mounted while its preceding live activity fades, then
 * releases its space. Historical mounts never replay the completion motion. */
export function TaskChatTurnHandoff({ settled, activity, children }: {
  settled: boolean;
  activity: ReactNode;
  children: (complete: boolean) => ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const previousActivity = useRef<ReactNode>(null);
  const [finished, setFinished] = useState(false);
  useLayoutEffect(() => {
    if (!settled) {
      previousActivity.current = activity;
      setFinished(false);
    }
  }, [settled, activity]);
  const transitioning = settled && Boolean(previousActivity.current) && reducedMotion === false && !finished;
  const complete = settled && !transitioning;
  useEffect(() => {
    if (!transitioning) return;
    // Transition events can be skipped in a background tab or when motion
    // tokens are set to zero. Always release the retained activity eventually.
    const styles = getComputedStyle(document.documentElement);
    const duration = ["--motion-conversation-handoff-fade", "--motion-conversation-handoff-fold", "--motion-duration-fast"]
      .reduce((sum, token) => sum + parseCssTimeMs(styles.getPropertyValue(token)), 0);
    const timer = window.setTimeout(() => setFinished(true), duration);
    return () => window.clearTimeout(timer);
  }, [transitioning]);
  return <div data-testid="task-chat-turn-handoff" data-handoff-state={transitioning ? "settling" : settled ? "settled" : "live"}>
    <div
      className="conversation-handoff-activity"
      data-testid="task-chat-handoff-activity"
      data-collapsing={settled ? "true" : "false"}
      aria-hidden={settled || undefined}
      inert={settled || undefined}
      onTransitionEnd={event => {
        if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && settled) setFinished(true);
      }}
    >
      <div className="min-h-0 overflow-hidden">{settled ? transitioning ? previousActivity.current : null : activity}</div>
    </div>
    <div data-testid="task-chat-handoff-response">{children(complete)}</div>
  </div>;
}
