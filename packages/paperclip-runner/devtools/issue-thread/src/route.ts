/**
 * Deterministic route scheme from the Capability UX contract §10.1, plus the
 * Capability clean-room surface.
 *
 * `#/issue/<fixtureProfile>?shot=<slug>&panel=<section>&rec=<id>&at=<ordinal>&seg=thread|evidence`
 * `#/chat?panel=<section>&rec=<id>&seg=thread|evidence`
 *
 * Parameters are also accepted on the document query string so a capture tool
 * can address a state without depending on hash-fragment escaping.
 *
 * The clean-room surface has no fixture, shot, or replay ordinal by design: it
 * starts blank and is always a live Codex session. `mode` is pinned to `live`
 * there rather than parsed, so no URL can talk the clean room into answering
 * with a fixture or a recording.
 */

import type { CapabilityEvidenceSectionId } from "../../../src/issue-thread/types";
import { CAPABILITY_EVIDENCE_SECTIONS } from "../../../src/issue-thread/types";
import { CAPABILITY_DEFAULT_FIXTURE_PROFILE } from "../../../src/issue-thread/fixtures";

export type CapabilitySurface = "issue" | "chat";

export interface CapabilityRoute {
  surface: CapabilitySurface;
  fixtureProfile: string;
  shot: string | null;
  panel: CapabilityEvidenceSectionId | null;
  record: string | null;
  at: number | null;
  segment: "thread" | "evidence";
  /** `live` opts into the package session server; otherwise fixtures render. */
  mode: "fake" | "live" | "replay";
}

const SECTION_IDS = new Set<string>(CAPABILITY_EVIDENCE_SECTIONS.map((section) => section.id));

function mergeParams(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const queryIndex = hash.indexOf("?");
  if (queryIndex >= 0) {
    for (const [key, value] of new URLSearchParams(hash.slice(queryIndex + 1))) {
      params.set(key, value);
    }
  }
  return params;
}

export function parseCapabilityRoute(url: {
  search: string;
  hash: string;
}): CapabilityRoute {
  const params = mergeParams(url.search, url.hash);
  const path = url.hash.replace(/^#/, "").split("?")[0] ?? "";
  const chat = /^\/chat\/?$/.test(path);
  const match = /^\/issue\/([^/?]+)/.exec(path);
  const shot = chat ? null : params.get("shot");
  const requestedMode = params.get("mode");
  const panel = params.get("panel");
  const at = params.get("at");
  const segment = params.get("seg");
  const mode = chat
    ? ("live" as const)
    : requestedMode === "live" || requestedMode === "replay" || requestedMode === "fake"
      ? requestedMode
      : shot === "replay-mode"
        ? "replay"
        : "fake";
  return {
    surface: chat ? "chat" : "issue",
    fixtureProfile: match?.[1] ?? CAPABILITY_DEFAULT_FIXTURE_PROFILE,
    shot,
    panel: panel !== null && SECTION_IDS.has(panel) ? (panel as CapabilityEvidenceSectionId) : null,
    record: params.get("rec"),
    at: chat || at === null || !/^\d+$/.test(at) ? null : Number.parseInt(at, 10),
    segment: segment === "evidence" ? "evidence" : "thread",
    mode,
  };
}

export function capabilityRouteHref(route: CapabilityRoute, overrides: Partial<CapabilityRoute>): string {
  const next = { ...route, ...overrides };
  const params = new URLSearchParams();
  if (next.surface === "chat") {
    if (next.panel !== null) params.set("panel", next.panel);
    if (next.record !== null) params.set("rec", next.record);
    if (next.segment !== "thread") params.set("seg", next.segment);
    const chatQuery = params.toString();
    return `#/chat${chatQuery.length > 0 ? `?${chatQuery}` : ""}`;
  }
  if (next.shot !== null) params.set("shot", next.shot);
  if (next.mode !== "fake") params.set("mode", next.mode);
  if (next.panel !== null) params.set("panel", next.panel);
  if (next.record !== null) params.set("rec", next.record);
  if (next.at !== null) params.set("at", String(next.at));
  if (next.segment !== "thread") params.set("seg", next.segment);
  const query = params.toString();
  return `#/issue/${next.fixtureProfile}${query.length > 0 ? `?${query}` : ""}`;
}
