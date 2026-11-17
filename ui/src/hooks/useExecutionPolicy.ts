import { useEffect, useMemo, useRef } from "react";
import { readExecutionPolicy } from "../lib/issue-execution-policy";
import { captureBrowserException } from "../lib/sentry";

/** Keep an invalid policy visible without crashing the task or enabling edits. */
export function useExecutionPolicy(value: unknown) {
  const result = useMemo(() => readExecutionPolicy(value), [value]);
  const reported = useRef(false);
  useEffect(() => {
    if (result.success || reported.current) return;
    reported.current = true;
    // Schema diagnostics can contain the original data. Report only a closed
    // field category, once per mounted component, through the existing gate.
    const field = result.error.issues[0]?.path[0];
    const category = field === "stages" ? "stages"
      : field === "monitor" ? "monitor"
        : field === "authorizationPolicy" ? "authorization"
          : field === "reviewPreset" ? "review_preset"
            : "policy";
    captureBrowserException(new Error(`Invalid task execution policy (${category})`));
  }, [result]);
  return result;
}
