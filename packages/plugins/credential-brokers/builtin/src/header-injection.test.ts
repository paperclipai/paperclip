import { describe, expect, it } from "vitest";

import { rewriteHeadersForUpstream } from "./header-injection.js";

const githubRule = {
  connectionId: "c-1",
  header: "Authorization",
  format: "Bearer {value}",
};

describe("rewriteHeadersForUpstream", () => {
  it("injects the bearer for the matched host rule", () => {
    const r = rewriteHeadersForUpstream({
      headers: { accept: "application/json" },
      rule: githubRule,
      bearer: "REAL-TOKEN",
      knownPlaceholders: [],
    });
    expect(r.headers.authorization).toBe("Bearer REAL-TOKEN");
    expect(r.injected).toBe(true);
    expect(r.strippedPlaceholder).toBe(false);
  });

  it("strips header values containing a placeholder substring", () => {
    const r = rewriteHeadersForUpstream({
      headers: {
        authorization: "Bearer __paperclip_broker_c-1_GH__",
        "x-other": "fine",
      },
      rule: undefined,
      bearer: undefined,
      knownPlaceholders: ["__paperclip_broker_c-1_GH__"],
    });
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers["x-other"]).toBe("fine");
    expect(r.strippedPlaceholder).toBe(true);
    expect(r.injected).toBe(false);
  });

  it("does both — strips placeholder authorization AND injects the real bearer", () => {
    const r = rewriteHeadersForUpstream({
      headers: {
        authorization: "Bearer __paperclip_broker_c-1_GH__",
        "user-agent": "agent",
      },
      rule: githubRule,
      bearer: "REAL-TOKEN",
      knownPlaceholders: ["__paperclip_broker_c-1_GH__"],
    });
    expect(r.headers.authorization).toBe("Bearer REAL-TOKEN");
    expect(r.strippedPlaceholder).toBe(true);
    expect(r.injected).toBe(true);
    expect(r.headers["user-agent"]).toBe("agent");
  });

  it("does not inject when the bearer cache is empty (placeholder still stripped)", () => {
    const r = rewriteHeadersForUpstream({
      headers: { authorization: "Bearer __paperclip_broker_c-1_GH__" },
      rule: githubRule,
      bearer: undefined,
      knownPlaceholders: ["__paperclip_broker_c-1_GH__"],
    });
    expect(r.headers.authorization).toBeUndefined();
    expect(r.injected).toBe(false);
    expect(r.strippedPlaceholder).toBe(true);
  });

  it("does not inject when there's no host rule (placeholder still stripped)", () => {
    const r = rewriteHeadersForUpstream({
      headers: { authorization: "Bearer __paperclip_broker_c-1_GH__" },
      rule: undefined,
      bearer: "REAL-TOKEN",
      knownPlaceholders: ["__paperclip_broker_c-1_GH__"],
    });
    expect(r.headers.authorization).toBeUndefined();
    expect(r.injected).toBe(false);
    expect(r.strippedPlaceholder).toBe(true);
  });

  it("treats $-sequences in the bearer as literal text (no String.replace shenanigans)", () => {
    const r = rewriteHeadersForUpstream({
      headers: {},
      rule: githubRule,
      bearer: "ghs_$&LOOKS$_$LIKE$REGEX'$$",
      knownPlaceholders: [],
    });
    expect(r.headers.authorization).toBe("Bearer ghs_$&LOOKS$_$LIKE$REGEX'$$");
  });

  it("supports format strings without {value} (raw value)", () => {
    const r = rewriteHeadersForUpstream({
      headers: {},
      rule: { ...githubRule, format: "raw-only" },
      bearer: "REAL-TOKEN",
      knownPlaceholders: [],
    });
    expect(r.headers.authorization).toBe("REAL-TOKEN");
  });

  it("handles array-valued headers (cookies etc.)", () => {
    const r = rewriteHeadersForUpstream({
      headers: {
        "set-cookie": ["a=1", "leaked=__paperclip_broker_c-1_GH__"],
      },
      rule: undefined,
      bearer: undefined,
      knownPlaceholders: ["__paperclip_broker_c-1_GH__"],
    });
    expect(r.headers["set-cookie"]).toEqual(["a=1"]);
    expect(r.strippedPlaceholder).toBe(true);
  });
});
