import { describe, expect, it } from "vitest";
import type { AcpPermissionRequest } from "acpx/runtime";
import { normalizeAcpxPermission } from "./acp-permission-adapter.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotToolEvidence } from "./copilot-tool-evidence.js";

function request(kinds = ["allow_once", "allow_always", "reject_once"]): AcpPermissionRequest {
  return { sessionId: "session", inferredKind: "edit", raw: {
    sessionId: "session", toolCall: { toolCallId: "call", title: "Edit source" },
    options: kinds.map((kind, i) => ({ kind, optionId: `option-${i}`, name: kind })),
  } } as AcpPermissionRequest;
}
describe("ACP permission normalization", () => {
  it.each([undefined, "codex", "claude", "pi", "copilot"])("preserves existing %s native identity behavior", provider => {
    const native = request(); native.raw.toolCall.toolCallId = "native\u0000tool";
    expect(normalizeAcpxPermission(native, { provider }).toolCallId).toBe("native\u0000tool");
  });
  it.each([undefined, null, "", "   ", "x".repeat(241)])("rejects missing or oversized Cursor identities without deriving one from other fields", toolCallId => {
    const native = request();
    Object.assign(native.raw.toolCall, { toolCallId, itemId: "fallback", title: "safe-tool" });
    expect(() => normalizeAcpxPermission(native, { provider: "cursor" })).toThrow("tool identity");
  });
  it("keeps requests answerable when a provider omits its operation title", () => {
    for (const title of [undefined, "", "   "]) {
      const value = request();
      value.raw.toolCall.title = title;
      expect(normalizeAcpxPermission(value).title).toBe("Approve provider operation");
    }
  });
  it("offers only native choices and preserves cancellation", () => {
    const value = normalizeAcpxPermission(request(["allow_once"]));
    expect(value.choices.map(c => c.key)).toEqual(["accept", "cancel"]);
    expect(value.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
    expect(value.resolve({ action: "cancel" })).toEqual({ outcome: "cancel" });
    expect(() => value.resolve({ action: "accept_for_session" })).toThrow("offered choice");
    expect(() => value.resolve({ action: "submit", content: { accept: true } })).toThrow("offered choice");
  });
  it("maps once, session and denial distinctly", () => {
    const value = normalizeAcpxPermission(request(), { allowAlwaysScope: "session" });
    expect(value.resolve({ action: "accept_for_session" })).toEqual({ outcome: "allow_always" });
    expect(value.resolve({ action: "decline" })).toEqual({ outcome: "reject_once" });
  });
  it("does not label an unverified persistent allowance as session-only", () => {
    const value = normalizeAcpxPermission(request());
    expect(value.choices.map(choice => choice.key)).toEqual(["accept", "decline", "cancel"]);
    expect(() => value.resolve({ action: "accept_for_session" })).toThrow("offered choice");
  });
  it("does not turn a one-time denial into permanent rejection", () => {
    expect(normalizeAcpxPermission(request(["reject_always"])).choices).toEqual([{ key: "cancel", label: "Cancel" }]);
  });
  it("rejects ambiguous provider choices before any resolution", () => {
    expect(() => normalizeAcpxPermission(request(["allow_once", "allow_once"]))).toThrow("ambiguous");
    const duplicate = request(); duplicate.raw.options[1]!.optionId = duplicate.raw.options[0]!.optionId;
    expect(() => normalizeAcpxPermission(duplicate)).toThrow("ambiguous");
  });
  it("keeps a native absolute workspace alias answerable with the same projected target", () => {
    const root = mkdtempSync(join(tmpdir(), "copilot-permission-alias-"));
    try {
      const workspace = join(root, "workspace"), alias = join(root, "alias");
      mkdirSync(workspace); mkdirSync(join(workspace, "nested")); symlinkSync(workspace, alias);
      const path = join(alias, "nested", "new.txt"), value = request();
      value.raw.toolCall = { toolCallId: "patch-call", kind: "edit", rawInput: { fileName: path }, locations: [{ path }] };
      const cwd = realpathSync(workspace), normalized = normalizeAcpxPermission(value, { provider: "copilot", workingDirectory: cwd });
      expect(normalized.title).toBe("Change file: nested/new.txt");
      expect(normalized.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
      const events: any[] = [];
      const projection = createCopilotToolEvidence({ sessionId: "session", turnId: "turn", workingDirectory: cwd, active: () => true, emit: event => events.push(event) });
      projection.permission(value, "permission", normalized.choices.map(choice => choice.key));
      expect(events[0].payload.details).toContainEqual({ name: "target", value: "nested/new.txt" });
      writeFileSync(join(workspace, "nested", "new.txt"), "existing");
      expect(normalizeAcpxPermission(value, { provider: "copilot", workingDirectory: cwd }).title).toBe(normalized.title);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses outside, dangling, conflicting and unresolvable alias targets", () => {
    const root = mkdtempSync(join(tmpdir(), "copilot-permission-alias-"));
    try {
      const workspace = join(root, "workspace"), alias = join(root, "alias"), outside = join(root, "outside");
      mkdirSync(workspace); mkdirSync(outside); symlinkSync(workspace, alias);
      symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling.txt"));
      symlinkSync(outside, join(workspace, "escape"));
      writeFileSync(join(outside, "existing.txt"), "outside");
      for (const path of [join(alias, "dangling.txt"), join(alias, "escape", "new.txt"), join(alias, "escape", "existing.txt"), join(alias, "missing-parent", "new.txt"), join(outside, "new.txt")]) {
        const value = request(); value.raw.toolCall = { toolCallId: "patch-call", kind: "edit", rawInput: { fileName: path }, locations: [{ path }] };
        const normalized = normalizeAcpxPermission(value, { provider: "copilot", workingDirectory: realpathSync(workspace) });
        expect(normalized.title).toContain("target unavailable");
        expect(normalized.choices.map(choice => choice.key)).toEqual(["decline", "cancel"]);
      }
      const conflict = request(); conflict.raw.toolCall = { toolCallId: "patch-call", kind: "edit", rawInput: { fileName: join(alias, "one.txt") }, locations: [{ path: join(alias, "two.txt") }] };
      expect(normalizeAcpxPermission(conflict, { provider: "copilot", workingDirectory: realpathSync(workspace) }).title).toContain("target unavailable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe("Copilot canonical file permission context", () => {
  const context = { provider: "copilot", workingDirectory: "/fixture/workspace", allowAlwaysScope: "session" as const };
  function edit(call: Record<string, unknown> = {}) {
    const value = request();
    Object.assign(value.raw.toolCall, { kind: "edit", title: "Create file", rawInput: { path: "/fixture/workspace/new.txt", content: "PRIVATE_CONTENT" }, locations: [{ path: "new.txt" }], ...call });
    return value;
  }
  it("puts only the safe target in the first canonical prompt and keeps offered grants", () => {
    const normalized = normalizeAcpxPermission(edit(), context);
    expect(normalized.title).toBe("Change file: new.txt");
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE_CONTENT");
    expect(normalized.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
    expect(normalized.resolve({ action: "accept_for_session" })).toEqual({ outcome: "allow_always" });
    expect(normalized.resolve({ action: "decline" })).toEqual({ outcome: "reject_once" });
  });
  it.each([
    { rawInput: {}, locations: [] },
    { rawInput: { path: "../outside.txt" }, locations: [] },
    { rawInput: { path: " new.txt" }, locations: [] },
    { rawInput: { path: "new.txt " }, locations: [] },
    { rawInput: { path: "/fixture/workspace/new.txt " }, locations: [] },
    { rawInput: { path: "/elsewhere/file" }, locations: [] },
    { rawInput: { path: "new.txt", fileName: "other.txt" }, locations: [] },
    { rawInput: { path: "new.txt" }, locations: [{ path: "other.txt" }] },
    { rawInput: { path: "new.txt" }, locations: [{}] },
    { rawInput: { path: "new.txt" }, locations: "invalid" },
    { rawInput: { path: "bad\nname" }, locations: [] },
    { rawInput: { path: "safe\u202Etxt.exe" }, locations: [] },
    { rawInput: { path: "safe\u2028other" }, locations: [] },
    { rawInput: { path: "safe\u0085other" }, locations: [] },
    { rawInput: { path: "a".repeat(1025) }, locations: [] },
    { rawInput: { path: "new.txt" }, locations: Array.from({ length: 17 }, () => ({ path: "new.txt" })) },
    { rawInput: { path: "https://private.example/file" }, locations: [] },
    { rawInput: { path: "secret?token=private-value" }, locations: [] },
  ])("offers no grant for absent, unsafe or conflicting context: %j", call => {
    const normalized = normalizeAcpxPermission(edit(call), context);
    expect(normalized.title).toContain("target unavailable");
    expect(normalized.choices.map(choice => choice.key)).toEqual(["decline", "cancel"]);
    for (const action of ["accept", "accept_for_session"] as const) expect(() => normalized.resolve({ action })).toThrow("not an offered choice");
    expect(normalized.resolve({ action: "decline" })).toEqual({ outcome: "reject_once" });
    expect(normalized.resolve({ action: "cancel" })).toEqual({ outcome: "cancel" });
  });
  it("requires the bound workspace and does not infer edits from title/inferredKind", () => {
    expect(normalizeAcpxPermission(edit(), { provider: "copilot" }).choices.map(x => x.key)).toEqual(["decline", "cancel"]);
    for (const kind of [undefined, "execute", "read"]) {
      const normalized = normalizeAcpxPermission(edit({ kind }), context);
      expect(normalized.title).toBe("Create file");
      expect(normalized.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
    }
    expect(normalizeAcpxPermission(edit(), { ...context, provider: "pi" }).title).toBe("Create file");
  });
  it("does not invent a grant when context is valid but the provider did not offer one", () => {
    const value = edit(); value.raw.options = request(["reject_once"]).raw.options;
    expect(normalizeAcpxPermission(value, context).choices.map(x => x.key)).toEqual(["decline", "cancel"]);
  });
});
