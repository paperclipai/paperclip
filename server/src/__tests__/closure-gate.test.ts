import { describe, expect, it } from "vitest";
import {
  CLOSURE_GATE_KIND_TOKENS,
  CLOSURE_GATE_SIGNAL,
  CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST,
  assertClosureAllowed,
  evaluateClosureGate,
  parseClosureFields,
  resolveClosureGateInput,
} from "../services/closure-gate.js";

describe("closure-gate kind/title constants", () => {
  it("exposes the no-code / data-only / ui-only kind tokens", () => {
    expect(CLOSURE_GATE_KIND_TOKENS).toEqual(["no-code", "data-only", "ui-only"]);
  });

  it("exposes the documented title prefix allowlist", () => {
    expect(CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST).toEqual(["[UI]", "[DATA]", "[GAP]", "[NO-CODE]"]);
  });

  it("names Signal A as the Fabricated SHA signal", () => {
    expect(CLOSURE_GATE_SIGNAL.FabricatedSha).toBe("Signal A (Fabricated SHA)");
  });
});

describe("evaluateClosureGate — Fix-SHA path", () => {
  it("accepts a closure with a Fix-SHA that is reachable upstream", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Wrapped up the bug.\n\nFix-SHA: abc1234567",
      issueTitle: "Fix login redirect loop",
      issueDescription: "Auth middleware misroutes.",
      knownUpstreamShas: ["abc1234567"],
    });
    expect(verdict).toEqual({ ok: true, reason: "valid_fix_sha" });
  });

  it("accepts multiple Fix-SHAs when every SHA is reachable", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Fix-SHA: deadbeef and Fix-SHA: feedface1234 both land upstream.",
      issueTitle: "Split cleanup",
      issueDescription: null,
      knownUpstreamShas: ["deadbeef", "feedface1234"],
    });
    expect(verdict).toEqual({ ok: true, reason: "valid_fix_sha" });
  });

  it("rejects a closure that references a SHA absent from knownUpstreamShas", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Done.\n\nFix-SHA: 0123456789abcdef",
      issueTitle: "Fix login redirect loop",
      issueDescription: null,
      knownUpstreamShas: ["different-sha"],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
    expect((verdict.details as { fabricatedShas?: string[] }).fabricatedShas).toContain("0123456789abcdef");
  });

  it("rejects a closure with a Fix-SHA when knownUpstreamShas is empty (current state)", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Fix-SHA: 0123456789abcdef",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });
});

describe("evaluateClosureGate — no-code escape hatch", () => {
  it("skips SHA verification for a [DATA] issue with `Kind: no-code` marker", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Rotated the webhook secret in the Secrets Vault.\n\nKind: no-code",
      issueTitle: "[DATA] Rotate Stripe webhook secret",
      issueDescription: "Rotate the production Stripe webhook signing secret.",
      knownUpstreamShas: [],
    });
    expect(verdict).toEqual({ ok: true, reason: "no_code_escape_hatch", kind: "no-code" });
  });

  it("skips SHA verification for a [UI] issue with no marker but a title prefix", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Adjusted the empty-state copy on the dashboard widget.",
      issueTitle: "[UI] Polish dashboard empty state",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict).toEqual({ ok: true, reason: "no_code_escape_hatch", kind: "no-code" });
  });

  it("rejects allowlisted tokens nested inside a non-allowlisted title prefix", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Closed without a Fix-SHA.",
      issueTitle: "[inject [UI] hidden attack vector] Refactor middleware",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });

  it("skips SHA verification when the description declares a `Kind:` even without a title prefix", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Updated pipeline fixture content.",
      issueTitle: "Refresh pipeline fixture snapshot",
      issueDescription: "Pipeline fixture maintenance.\n\nKind: data-only",
      knownUpstreamShas: [],
    });
    expect(verdict).toEqual({ ok: true, reason: "no_code_escape_hatch", kind: "no-code" });
  });

  it("does not let the no-code hatch swallow a fabricated Fix-SHA", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Kind: no-code\n\nFix-SHA: 0123456789abcdef",
      issueTitle: "[DATA] Rotate secret",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });
});

describe("evaluateClosureGate — non-exempt closures", () => {
  it("rejects a closure with no Fix-SHA and no allowlist membership", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Closed this out manually.",
      issueTitle: "Refactor middleware ordering",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });

  it("treats an unknown kind token as missing marker", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Kind: doc-only",
      issueTitle: "Update docs",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });

  it("treats whitespace-only closure comments as missing markers", () => {
    const verdict = evaluateClosureGate({
      closureComment: "   \n  ",
      issueTitle: "[UI] Tweak button",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.reason).toBe("no_code_escape_hatch");
  });
});

describe("assertClosureAllowed", () => {
  it("returns the verdict on success", () => {
    const verdict = assertClosureAllowed({
      closureComment: "Kind: no-code",
      issueTitle: "[GAP] Realign runbooks",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(true);
  });

  it("throws an HttpError carrying the closure_gate_blocked code on rejection", () => {
    expect(() =>
      assertClosureAllowed({
        closureComment: "Closed without a SHA.",
        issueTitle: "Implement caching",
        issueDescription: null,
        knownUpstreamShas: [],
      }),
    ).toThrowError(/Closure-gate/);
  });
});

describe("parseClosureFields", () => {
  it("extracts Fix-SHAs and the kind marker independently", () => {
    const parsed = parseClosureFields("Fix-SHA: abc1234567\n\nKind: no-code");
    expect(parsed.fixShas).toEqual(["abc1234567"]);
    expect(parsed.shortPrefixes).toEqual([]);
    expect(parsed.kindMarker).toBe("no-code");
  });

  it("returns null kindMarker when the comment is absent", () => {
    const parsed = parseClosureFields(null);
    expect(parsed.fixShas).toEqual([]);
    expect(parsed.shortPrefixes).toEqual([]);
    expect(parsed.kindMarker).toBeNull();
  });

  it("partitions short SHA prefixes (<10 chars) into shortPrefixes", () => {
    const parsed = parseClosureFields("Fix-SHA: abc1234\n\nFix-SHA: abc12345");
    expect(parsed.fixShas).toEqual([]);
    expect(parsed.shortPrefixes).toEqual(["abc1234", "abc12345"]);
  });
});

describe("evaluateClosureGate — short-prefix safety (Signal D)", () => {
  it("never signals Fabrication on a 7-char Fix-SHA prefix", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Done. Fix-SHA: abc1234",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.AmbiguousShortPrefix);
    expect((verdict.details as { shortPrefixes?: string[] }).shortPrefixes).toEqual(["abc1234"]);
  });

  it("never signals Fabrication on an 8-char Fix-SHA prefix", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Done. Fix-SHA: deadbeef",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.AmbiguousShortPrefix);
  });

  it("never signals Fabrication on a 9-char Fix-SHA prefix", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Done. Fix-SHA: feedface9",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.AmbiguousShortPrefix);
  });

  it("does not collide with the no-code escape hatch for a short-prefix [UI] issue", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Adjusted the empty-state copy. Fix-SHA: abc1234",
      issueTitle: "[UI] Polish dashboard empty state",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict).toEqual({ ok: true, reason: "no_code_escape_hatch", kind: "no-code" });
  });

  it("treats a 10-char prefix as a fully-falsifiable SHA and rejects it when not reachable", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Done. Fix-SHA: 0123456789",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: ["different-sha"],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
    expect((verdict.details as { fabricatedShas?: string[] }).fabricatedShas).toContain("0123456789");
  });

  it("accepts a 10-char prefix that resolves to a known upstream SHA", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Done. Fix-SHA: 0123456789",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: ["0123456789"],
    });
    expect(verdict).toEqual({ ok: true, reason: "valid_fix_sha" });
  });

  it("accepts a full 40-char SHA when reachable", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const verdict = evaluateClosureGate({
      closureComment: `Done. Fix-SHA: ${full}`,
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [full],
    });
    expect(verdict).toEqual({ ok: true, reason: "valid_fix_sha" });
  });

  it("rejects a full 40-char SHA when not reachable", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const verdict = evaluateClosureGate({
      closureComment: `Done. Fix-SHA: ${full}`,
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });

  it("prefers the long-SHA fabrication verdict when a comment mixes short and long Fix-SHAs", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Fix-SHA: abc1234 (short) and Fix-SHA: 0123456789abcdef",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
    expect((verdict.details as { fabricatedShas?: string[] }).fabricatedShas).toContain("0123456789abcdef");
    expect((verdict.details as { shortPrefixes?: string[] }).shortPrefixes).toContain("abc1234");
  });

  it("accepts a mixed short+long Fix-SHA closure when the long SHA is reachable", () => {
    const verdict = evaluateClosureGate({
      closureComment: "Fix-SHA: abc1234 (short) and Fix-SHA: 0123456789",
      issueTitle: "Refactor adapter",
      issueDescription: null,
      knownUpstreamShas: ["0123456789"],
    });
    expect(verdict).toEqual({ ok: true, reason: "valid_fix_sha" });
  });
});

describe("resolveClosureGateInput — pending body wins over persisted issue", () => {
  it("uses the existing title when the body does not include one", () => {
    const resolved = resolveClosureGateInput({
      body: { comment: "Fix-SHA: 0123456789abcdef" },
      existing: { title: "Refactor adapter", description: "Some description" },
    });
    expect(resolved.issueTitle).toBe("Refactor adapter");
  });

  it("honors a pending body title so renaming to [UI] then closing takes the escape hatch", () => {
    const resolved = resolveClosureGateInput({
      body: { title: "[UI] Tweak dashboard copy", comment: "Kind: no-code" },
      existing: { title: "Refactor adapter", description: null },
    });
    expect(resolved.issueTitle).toBe("[UI] Tweak dashboard copy");
  });

  it("uses the existing description when the body does not include one (preserves Kind: declaration)", () => {
    const resolved = resolveClosureGateInput({
      body: { title: "Refactor adapter" },
      existing: { title: "Refactor adapter", description: "Kind: data-only" },
    });
    expect(resolved.issueDescription).toBe("Kind: data-only");
  });

  it("honors a pending body description so a same-PATCH exemption override applies", () => {
    const resolved = resolveClosureGateInput({
      body: { description: "Kind: no-code\nNew notes.", comment: "Closing without code." },
      existing: { title: "[DATA] Rotate secret", description: null },
    });
    expect(resolved.issueDescription).toBe("Kind: no-code\nNew notes.");
  });

  it("returns closureComment as null when the body has no comment field", () => {
    const resolved = resolveClosureGateInput({
      body: {},
      existing: { title: "Refactor adapter", description: null },
    });
    expect(resolved.closureComment).toBeNull();
  });

  it("passes the closure comment through verbatim when present (including empty string)", () => {
    const resolved = resolveClosureGateInput({
      body: { comment: "   " },
      existing: { title: "Refactor adapter", description: null },
    });
    expect(resolved.closureComment).toBe("   ");
  });

  it("rejects the pending title when it is whitespace-only (falls back to existing)", () => {
    const resolved = resolveClosureGateInput({
      body: { title: "   \n  ", comment: "Closing" },
      existing: { title: "[UI] Polish", description: null },
    });
    expect(resolved.issueTitle).toBe("[UI] Polish");
  });
});

describe("resolveClosureGateInput → evaluateClosureGate integration (route-equivalent behavior)", () => {
  it("rejects a commentless closure on a non-exempt title (so the gate cannot be bypassed by omitting comment)", () => {
    const resolved = resolveClosureGateInput({
      body: {},
      existing: { title: "Refactor adapter", description: null },
    });
    const verdict = evaluateClosureGate({
      closureComment: resolved.closureComment,
      issueTitle: resolved.issueTitle,
      issueDescription: resolved.issueDescription,
      knownUpstreamShas: [],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.signal).toBe(CLOSURE_GATE_SIGNAL.FabricatedSha);
  });

  it("accepts a commentless closure when the body renames a non-exempt issue to an allowlist prefix", () => {
    const resolved = resolveClosureGateInput({
      body: { title: "[UI] Polish dashboard copy" },
      existing: { title: "Refactor adapter", description: null },
    });
    const verdict = evaluateClosureGate({
      closureComment: resolved.closureComment,
      issueTitle: resolved.issueTitle,
      issueDescription: resolved.issueDescription,
      knownUpstreamShas: [],
    });
    expect(verdict).toEqual({ ok: true, reason: "no_code_escape_hatch", kind: "no-code" });
  });

  it("accepts a same-PATCH [DATA] closure when body adds Kind: no-code to the comment", () => {
    const resolved = resolveClosureGateInput({
      body: { comment: "Rotated the webhook secret.\n\nKind: no-code" },
      existing: { title: "[DATA] Rotate Stripe webhook secret", description: null },
    });
    const verdict = evaluateClosureGate({
      closureComment: resolved.closureComment,
      issueTitle: resolved.issueTitle,
      issueDescription: resolved.issueDescription,
      knownUpstreamShas: [],
    });
    expect(verdict).toEqual({ ok: true, reason: "no_code_escape_hatch", kind: "no-code" });
  });
});