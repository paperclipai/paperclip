import { describe, expect, it } from "vitest";

import { parseCapabilityRoute, capabilityRouteHref } from "./route";

function at(hash: string, search = "") {
  return parseCapabilityRoute({ hash, search });
}

describe("Capability issue-thread routes", () => {
  it("keeps the existing deterministic scenario deep links intact", () => {
    const route = at("#/issue/dp-documents?shot=document-revision&panel=state&rec=doc-1&at=3&seg=evidence");

    expect(route.surface).toBe("issue");
    expect(route.fixtureProfile).toBe("dp-documents");
    expect(route.shot).toBe("document-revision");
    expect(route.panel).toBe("state");
    expect(route.record).toBe("doc-1");
    expect(route.at).toBe(3);
    expect(route.segment).toBe("evidence");
    expect(route.mode).toBe("fake");
    expect(capabilityRouteHref(route, {})).toBe(
      "#/issue/dp-documents?shot=document-revision&panel=state&rec=doc-1&at=3&seg=evidence",
    );
  });

  it("still infers replay mode from the replay shot and honours an explicit mode", () => {
    expect(at("#/issue/hb-baseline?shot=replay-mode").mode).toBe("replay");
    expect(at("#/issue/hb-baseline?mode=live").mode).toBe("live");
  });
});

describe("Capability clean-room route", () => {
  it("is reachable without naming a scenario", () => {
    const route = at("#/chat");

    expect(route.surface).toBe("chat");
    expect(route.shot).toBe(null);
    expect(route.at).toBe(null);
    expect(capabilityRouteHref(route, {})).toBe("#/chat");
  });

  it("is always live: no URL can downgrade it to a fixture or a recording", () => {
    for (const hash of [
      "#/chat",
      "#/chat?mode=fake",
      "#/chat?mode=replay",
      "#/chat?shot=replay-mode",
      "#/chat?shot=thread-baseline&at=4",
    ]) {
      const route = at(hash);
      expect(route.surface, hash).toBe("chat");
      expect(route.mode, hash).toBe("live");
      expect(route.shot, hash).toBe(null);
      expect(route.at, hash).toBe(null);
    }
    expect(at("", "?mode=fake#/chat").surface).toBe("issue");
  });

  it("carries only the evidence deep-link parameters back into its own href", () => {
    const route = at("#/chat?panel=calls&rec=call-1&seg=evidence");

    expect(route.panel).toBe("calls");
    expect(route.record).toBe("call-1");
    expect(route.segment).toBe("evidence");
    expect(capabilityRouteHref(route, {})).toBe("#/chat?panel=calls&rec=call-1&seg=evidence");
    expect(capabilityRouteHref(route, { panel: null, record: null, segment: "thread" })).toBe("#/chat");
  });

  it("switches surfaces without dragging scenario state across", () => {
    const chat = at("#/chat");
    expect(capabilityRouteHref(chat, { surface: "issue", fixtureProfile: "ar-artifacts" })).toBe(
      "#/issue/ar-artifacts?mode=live",
    );
  });
});
