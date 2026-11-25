import { useEffect, useRef, useState } from "react";
import type { RunStartupStage } from "@paperclipai/shared";

/** The startup step a claimed run is on, in the words the board shows. */
export const RUN_STARTUP_STAGE_LABELS: Readonly<Record<RunStartupStage, string>> = {
  getting_ready: "Getting ready",
  starting_environment: "Waking up",
  preparing_workspace: "Preparing workspace",
  restoring_session: "Restoring session",
  connecting_tools: "Connecting tools",
  starting_agent: "Starting agent",
};

export function runStartupStageLabel(
  stage: RunStartupStage | null | undefined,
  sessionResumed = false,
): string | null {
  if (!stage) return null;
  if (stage === "starting_agent" && sessionResumed) return "Resuming session";
  return RUN_STARTUP_STAGE_LABELS[stage] ?? null;
}

/**
 * How long a shown label stays before the next one replaces it. Startup steps
 * often take a few milliseconds, so a shorter hold would flicker.
 */
export const STARTUP_LABEL_MIN_DISPLAY_MS = 500;

/**
 * Shows a changed label at once when the current one has been visible for the
 * minimum time. Otherwise it waits out the rest of that time and then shows
 * the latest label, skipping any that came and went in between. Nothing is
 * delayed by a prediction of how long a step will last.
 */
export function useHeldLabel(label: string | null, minDisplayMs = STARTUP_LABEL_MIN_DISPLAY_MS): string | null {
  const [shown, setShown] = useState(label);
  const shownAtRef = useRef(Date.now());
  // Once the hold has passed, show the change in this render, not a later one.
  const holdPassed = label !== shown && Date.now() - shownAtRef.current >= minDisplayMs;
  useEffect(() => {
    if (label === shown) return;
    const remainingMs = minDisplayMs - (Date.now() - shownAtRef.current);
    const show = () => {
      shownAtRef.current = Date.now();
      setShown(label);
    };
    if (remainingMs <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, remainingMs);
    return () => clearTimeout(timer);
  }, [label, shown, minDisplayMs]);
  return holdPassed ? label : shown;
}
