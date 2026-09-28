export interface BrowserErrorDetails {
  boundary: "app" | "route";
  componentStack?: string | null;
}

const MAX_STACK_LENGTH = 16_384;
const MAX_COMPONENT_FRAMES = 40;

/** Keep component names only: React stack locations can contain tenant URLs. */
export function sanitizeComponentStack(stack: string | null | undefined): string | undefined {
  if (!stack) return undefined;
  const frames: string[] = [];
  for (const line of stack.slice(0, MAX_STACK_LENGTH).split("\n").slice(0, MAX_COMPONENT_FRAMES + 1)) {
    // V8/React and Firefox/Safari component-frame formats. Never retain the
    // location, arguments, or an unrecognized line as a fallback.
    const name = /^\s*(?:at|in) ([A-Za-z_$][\w$.-]{0,99})(?:\s|$)/.exec(line)?.[1]
      ?? /^([A-Za-z_$][\w$.-]{0,99})@/.exec(line)?.[1];
    if (name) frames.push(`    at ${name}`);
    if (frames.length === MAX_COMPONENT_FRAMES) break;
  }
  return frames.length ? `\n${frames.join("\n")}` : undefined;
}

/** A bounded snapshot, taken at the error rather than when the capture queue runs. */
export function buildBrowserErrorContext(details: BrowserErrorDetails) {
  const componentStack = sanitizeComponentStack(details.componentStack);
  const browserState: {
    ready_state?: "loading" | "interactive" | "complete";
    visibility_state?: "visible" | "hidden";
    translation_marker?: boolean;
  } = {};
  if (typeof document !== "undefined") {
    // Each read is optional. A DOM wrapper or extension must not prevent the
    // original exception and component trace from reaching the error monitor.
    try {
      const state = document.readyState;
      if (state === "loading" || state === "interactive" || state === "complete") {
        browserState.ready_state = state;
      }
    } catch { /* diagnostic unavailable */ }
    try {
      const state = document.visibilityState;
      if (state === "visible" || state === "hidden") browserState.visibility_state = state;
    } catch { /* diagnostic unavailable */ }
    try {
      const classes = document.documentElement.classList;
      browserState.translation_marker = classes.contains("translated-ltr") || classes.contains("translated-rtl");
    } catch { /* diagnostic unavailable */ }
  }
  return {
    tags: { react_error_boundary: details.boundary },
    contexts: {
      react: componentStack ? { componentStack } : {},
      browser_state: browserState,
    },
  };
}
