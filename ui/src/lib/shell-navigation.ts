export type ContextualSidebarSurface =
  | "settings"
  | "apps"
  | "agent"
  | "routine"
  | "skills"
  | `plugin:${string}`;

export interface ShellRouteClassification {
  companySegments: string[];
  isTaskDetail: boolean;
  builtInContextualSurface: Exclude<ContextualSidebarSurface, `plugin:${string}`> | null;
}

const CONTEXTUAL_ORIGIN_KEY_PREFIX = "paperclip.contextualSidebar.origin";

export function getCompanyPathSegments(pathname: string, companyPrefix: string | undefined): string[] {
  if (!companyPrefix) return [];
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  if (segments[0]?.toUpperCase() !== companyPrefix.toUpperCase()) return [];
  return segments.slice(1);
}

export function classifyShellRoute(
  pathname: string,
  companyPrefix: string | undefined,
): ShellRouteClassification {
  const companySegments = getCompanyPathSegments(pathname, companyPrefix);
  const root = companySegments[0]?.toLowerCase();
  const isCompanySettings = root === "company" && ["settings", "export", "import"].includes(
    companySegments[1]?.toLowerCase() ?? "",
  );
  const agentSegment = companySegments[1]?.toLowerCase();
  const isAgentDetail = root === "agents"
    && Boolean(agentSegment)
    && agentSegment !== "new"
    && !["all", "active", "paused", "error", "builtin"].includes(agentSegment ?? "");
  const isRoutineDetail = root === "routines" && companySegments.length >= 2;
  const isSkillsSurface = root === "skills";

  return {
    companySegments,
    isTaskDetail: root === "issues" && companySegments.length >= 2,
    builtInContextualSurface: isCompanySettings
      ? "settings"
      : root === "apps" || root === "tools"
        ? "apps"
        : isAgentDetail
          ? "agent"
          : isRoutineDetail
            ? "routine"
            : isSkillsSurface
              ? "skills"
        : null,
  };
}

function contextualOriginStorageKey(surface: ContextualSidebarSurface, companyPrefix: string) {
  return `${CONTEXTUAL_ORIGIN_KEY_PREFIX}:${companyPrefix.toUpperCase()}:${surface}`;
}

function isCompanyPath(pathname: string, companyPrefix: string) {
  const first = pathname.split("/").filter(Boolean)[0];
  return first?.toUpperCase() === companyPrefix.toUpperCase();
}

export function rememberContextualSidebarOrigin({
  surface,
  companyPrefix,
  previousPathname,
}: {
  surface: ContextualSidebarSurface;
  companyPrefix: string;
  previousPathname: string;
}) {
  if (typeof window === "undefined" || !isCompanyPath(previousPathname, companyPrefix)) return;

  try {
    window.sessionStorage.setItem(
      contextualOriginStorageKey(surface, companyPrefix),
      previousPathname,
    );
  } catch {
    // Navigation still has a deterministic fallback when storage is unavailable.
  }
}

export function readContextualSidebarOrigin({
  surface,
  companyPrefix,
  fallbackTo,
}: {
  surface: ContextualSidebarSurface;
  companyPrefix: string | null | undefined;
  fallbackTo: string;
}) {
  if (typeof window === "undefined" || !companyPrefix) return fallbackTo;

  try {
    const stored = window.sessionStorage.getItem(contextualOriginStorageKey(surface, companyPrefix));
    return stored && isCompanyPath(stored, companyPrefix) ? stored : fallbackTo;
  } catch {
    return fallbackTo;
  }
}
