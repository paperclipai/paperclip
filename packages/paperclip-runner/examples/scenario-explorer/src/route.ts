/**
 * Hash routing for the Capability scenario explorer.
 *
 * Static hosting means no server rewrites, so every linkable view lives in the
 * hash (UX map §7). Filter state mirrors into the route so any filtered picker
 * view is shareable; it is never protocol state.
 */

export type ScenarioChatnspectorView = "transcript" | "context" | "authorization" | "diff" | "parity";

/** The explorer reviews a corpus; the chat drives one session. Same shell. */
export type CapabilitySurface = "explorer" | "chat";

export type CapabilityChatView = "chat" | "activity";

export type CapabilityActivityFilter =
  | "all"
  | "tools"
  | "authorization"
  | "control"
  | "diff"
  | "parity";

export const CAPABILITY_ACTIVITY_FILTERS: readonly CapabilityActivityFilter[] = [
  "all",
  "tools",
  "authorization",
  "control",
  "diff",
  "parity",
];

export const CAPABILITY_INSPECTOR_VIEWS: readonly ScenarioChatnspectorView[] = [
  "transcript",
  "context",
  "authorization",
  "diff",
  "parity",
];

export interface CapabilityFilters {
  group: string | null;
  disposition: string | null;
  role: string | null;
  claim: string | null;
  parity: string | null;
  query: string;
}

export interface CapabilityRoute {
  surface: CapabilitySurface;
  caseId: string | null;
  run: "fake" | "codex" | null;
  /** `replay=fake` auto-plays the scripted session for screenshot routes. */
  replay: "fake" | null;
  view: ScenarioChatnspectorView;
  chatView: CapabilityChatView;
  /** Anchors and expands one turn group in the activity stream. */
  turn: number | null;
  activityFilter: CapabilityActivityFilter;
  /**
   * Holds the last scripted turn mid-stream so the streaming state can be
   * captured deterministically instead of raced by hand.
   */
  stage: "streaming" | null;
  filters: CapabilityFilters;
}

export const EMPTY_FILTERS: CapabilityFilters = {
  group: null,
  disposition: null,
  role: null,
  claim: null,
  parity: null,
  query: "",
};

export function parseCapabilityRoute(hash: string): CapabilityRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const params = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const surface: CapabilitySurface = segments[0] === "chat" ? "chat" : "explorer";
  const caseSegment = surface === "chat" ? segments[1] : segments[0] === "case" ? segments[1] : undefined;
  const caseId = caseSegment === undefined ? null : decodeURIComponent(caseSegment);
  const run = params.get("run");
  const view = params.get("view");
  const turn = Number.parseInt(params.get("turn") ?? "", 10);
  const filter = params.get("filter");
  return {
    surface,
    caseId,
    run: run === "fake" || run === "codex" ? run : null,
    replay: params.get("replay") === "fake" ? "fake" : null,
    view: isInspectorView(view) ? view : "transcript",
    chatView: view === "activity" ? "activity" : "chat",
    turn: Number.isInteger(turn) && turn >= 0 ? turn : null,
    activityFilter: isActivityFilter(filter) ? filter : "all",
    stage: params.get("stage") === "streaming" ? "streaming" : null,
    filters: {
      group: params.get("group"),
      disposition: params.get("disposition"),
      role: params.get("role"),
      claim: params.get("claim"),
      parity: params.get("parity"),
      query: params.get("q") ?? "",
    },
  };
}

export function serializeCapabilityRoute(route: CapabilityRoute): string {
  const params = new URLSearchParams();
  if (route.surface === "chat") return serializeChatRoute(route, params);
  if (route.run !== null) params.set("run", route.run);
  if (route.view !== "transcript") params.set("view", route.view);
  if (route.caseId === null) {
    for (const [key, value] of [
      ["group", route.filters.group],
      ["disposition", route.filters.disposition],
      ["role", route.filters.role],
      ["claim", route.filters.claim],
      ["parity", route.filters.parity],
    ] as const) {
      if (value !== null && value.length > 0) params.set(key, value);
    }
    if (route.filters.query.length > 0) params.set("q", route.filters.query);
  }
  const path = route.caseId === null ? "/" : `/case/${encodeURIComponent(route.caseId)}`;
  const query = params.toString();
  return `#${path}${query.length > 0 ? `?${query}` : ""}`;
}

export function activeFilterChips(
  filters: CapabilityFilters,
): Array<{ key: keyof CapabilityFilters; label: string; value: string }> {
  const chips: Array<{ key: keyof CapabilityFilters; label: string; value: string }> = [];
  if (filters.group !== null && filters.group.length > 0) {
    chips.push({ key: "group", label: "Group", value: filters.group });
  }
  if (filters.disposition !== null && filters.disposition.length > 0) {
    chips.push({ key: "disposition", label: "Disposition", value: filters.disposition });
  }
  if (filters.role !== null && filters.role.length > 0) {
    chips.push({ key: "role", label: "Role", value: filters.role });
  }
  if (filters.claim !== null && filters.claim.length > 0) {
    chips.push({ key: "claim", label: "Claim", value: filters.claim });
  }
  if (filters.parity !== null && filters.parity.length > 0) {
    chips.push({ key: "parity", label: "Parity", value: filters.parity });
  }
  if (filters.query.length > 0) {
    chips.push({ key: "query", label: "Search", value: filters.query });
  }
  return chips;
}

export function hasActiveFilters(filters: CapabilityFilters): boolean {
  return activeFilterChips(filters).length > 0;
}

function serializeChatRoute(route: CapabilityRoute, params: URLSearchParams): string {
  if (route.replay !== null) params.set("replay", route.replay);
  if (route.chatView !== "chat") params.set("view", route.chatView);
  if (route.turn !== null) params.set("turn", String(route.turn));
  if (route.activityFilter !== "all") params.set("filter", route.activityFilter);
  if (route.stage !== null) params.set("stage", route.stage);
  const path = route.caseId === null ? "/chat" : `/chat/${encodeURIComponent(route.caseId)}`;
  const query = params.toString();
  return `#${path}${query.length > 0 ? `?${query}` : ""}`;
}

function isInspectorView(value: string | null): value is ScenarioChatnspectorView {
  return value !== null && (CAPABILITY_INSPECTOR_VIEWS as readonly string[]).includes(value);
}

function isActivityFilter(value: string | null): value is CapabilityActivityFilter {
  return value !== null && (CAPABILITY_ACTIVITY_FILTERS as readonly string[]).includes(value);
}
