export type NavigationType = "POP" | "PUSH" | "REPLACE";

export const SIDEBAR_SCROLL_RESET_STATE = {
  paperclipSidebarScrollReset: true,
} as const;

export function shouldResetScrollOnNavigation(params: {
  previousPathname: string | null;
  pathname: string;
  navigationType: NavigationType;
  state: unknown;
}): boolean {
  const { previousPathname, pathname, navigationType, state } = params;
  if (previousPathname === null) return false;
  if (previousPathname === pathname) return false;
  if (navigationType === "POP") return false;
  if (isIssueDetailPathChange(previousPathname, pathname)) return true;
  return hasSidebarScrollResetState(state);
}

export function resetNavigationScroll(mainElement: HTMLElement | null): void {
  mainElement?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });

  if (mainElement) {
    mainElement.scrollTop = 0;
    mainElement.scrollLeft = 0;
  }

  const scrollingElement = document.scrollingElement ?? document.documentElement;
  if (scrollingElement) {
    scrollingElement.scrollTop = 0;
    scrollingElement.scrollLeft = 0;
  }

  if (document.body) {
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
  }

  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function hasSidebarScrollResetState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return (state as Record<string, unknown>).paperclipSidebarScrollReset === true;
}

function isIssueDetailPathChange(previousPathname: string, pathname: string): boolean {
  const previousIssueRef = readIssueDetailPathRef(previousPathname);
  const nextIssueRef = readIssueDetailPathRef(pathname);
  return previousIssueRef !== null && nextIssueRef !== null && previousIssueRef !== nextIssueRef;
}

function readIssueDetailPathRef(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "issues") {
    return segments[1] ?? null;
  }
  if (segments.length === 3 && segments[1] === "issues") {
    return segments[2] ?? null;
  }
  return null;
}
