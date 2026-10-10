import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { updateSingleReadEvidence } from "./single-read-evidence.js";
import { createCursorToolEvidence } from "./cursor-tool-evidence.js";
import { createCopilotToolEvidence } from "./copilot-tool-evidence.js";
import { validateAcpxRichEvent } from "./profile-extensions.js";
const path = `.paperclip-eval-action-${"a".repeat(36)}.txt`;
const hash = `sha256:${createHash("sha256").update(path).digest("hex")}`;
const origin = { type: "tool_call", tag: "tool_call", toolCallId: "read", kind: "read", status: "pending", rawInput: { path }, locations: [{ path }] };
it("attests one explicit input path and retains proof through omitted native update fields", () => {
  for (const rawInput of [{ path }, { fileName: `/workspace/${path}` }, { path, offset: 0, limit: 10 }]) {
    const state = updateSingleReadEvidence(undefined, { ...origin, rawInput }, "/workspace"); expect(state.targetSha256).toBe(hash);
    expect(updateSingleReadEvidence(state, { tag: "tool_call_update", status: "completed" }, "/workspace")).toEqual(state);
  }
});
it.each([
  { paths: [path] }, { path, paths: [path, "private.txt"] }, { path, fileName: path }, { path: [path] }, { path, extra: { path: "private.txt" } },
  { path, unknown: "private.txt" }, { path: "../private.txt" }, { path: "https://example.com/file" }, { shellId: "0" },
])("never attests ambiguous or unsafe input %j", rawInput => {
  expect(updateSingleReadEvidence(undefined, { ...origin, rawInput }, "/workspace").targetSha256).toBeUndefined();
  const state = updateSingleReadEvidence(undefined, origin, "/workspace");
  expect(() => updateSingleReadEvidence(state, { ...origin, tag: "tool_call_update", rawInput }, "/workspace")).toThrow();
});
it.each([[{ path }, { path }], [{ path }, { path: "../outside" }], [{ path: "other" }], null])("rejects ambiguous/conflicting locations %j", locations => {
  expect(updateSingleReadEvidence(undefined, { ...origin, locations }, "/workspace").targetSha256).toBeUndefined();
  const state = updateSingleReadEvidence(undefined, origin, "/workspace");
  expect(() => updateSingleReadEvidence(state, { tag: "tool_call_update", locations }, "/workspace")).toThrow();
});
it("does not establish proof from a late update or location/title without scalar input", () => {
  expect(updateSingleReadEvidence(undefined, { ...origin, tag: "tool_call_update" }, "/workspace")).toEqual({});
  const state = updateSingleReadEvidence(undefined, { ...origin, rawInput: undefined, title: `Read ${path}` }, "/workspace");
  expect(state).toEqual({}); expect(updateSingleReadEvidence(state, origin, "/workspace")).toEqual({});
});
it("completes an empty pending origin only from its full shape before execution progress", () => {
  const pending = updateSingleReadEvidence(undefined, { ...origin, rawInput: {}, locations: undefined }, "/workspace");
  expect(pending).toEqual({ pendingOriginInput: true });
  expect(updateSingleReadEvidence(pending, { tag: "tool_call_update", rawInput: { path }, locations: [{ path }] }, "/workspace")).toEqual({ targetSha256: hash });
  for (const status of ["in_progress", "completed", "failed"]) {
    const unproven = updateSingleReadEvidence(pending, { tag: "tool_call_update", status }, "/workspace");
    expect(updateSingleReadEvidence(unproven, { tag: "tool_call_update", rawInput: { path } }, "/workspace")).toEqual({});
  }
  for (const rawInput of [{ paths: [path, "private.txt"] }, { path, fileName: path }, { path: "../private.txt" }]) {
    const unproven = updateSingleReadEvidence(pending, { tag: "tool_call_update", rawInput }, "/workspace");
    expect(updateSingleReadEvidence(unproven, { tag: "tool_call_update", rawInput: { path } }, "/workspace")).toEqual({});
  }
});
for (const [provider, create] of [["cursor", createCursorToolEvidence], ["copilot", createCopilotToolEvidence]] as const) {
  describe(`${provider} passive single-read origin`, () => {
    function setup() { const rows: any[] = []; const projector = create({ sessionId: "session", turnId: "turn", workingDirectory: "/workspace", active: () => true,
      emit: event => { validateAcpxRichEvent(event); rows.push(Object.fromEntries((event.payload.details as any[]).map(d => [d.name, d.value]))); } }); return { rows, projector }; }
    it.each(["completed", "failed"])("retains exact proof in %s terminal and does not emit raw path", status => {
      const s = setup(); s.projector.tool(origin); s.projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "read", status });
      expect(s.rows.map(row => row.readTargetSha256)).toEqual([hash, hash]); expect(JSON.stringify(s.rows)).not.toContain(path);
      const firstTerminal = setup(); firstTerminal.projector.tool({ ...origin, status }); expect(firstTerminal.rows[0].readTargetSha256).toBe(hash);
    });
    it("marks changed same-path ambiguous input or locations incomplete without throwing through execution", () => {
      for (const fields of [{ rawInput: { path, paths: [path, "private.txt"] } }, { locations: [{ path }, { path: "private.txt" }] }]) {
        const s = setup(); s.projector.tool(origin);
        expect(() => s.projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "read", status: "completed", ...fields })).not.toThrow();
        expect(s.rows.at(-1).stage).toBe("evidence_incomplete");
      }
    });
    it("does not attest multi-file reads or inherit another tool's origin", () => {
      const s = setup(); s.projector.tool({ ...origin, rawInput: { paths: [path, "private.txt"] } });
      s.projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "other", kind: "read", status: "completed", rawInput: { path } });
      expect(s.rows).toHaveLength(1); expect(s.rows[0].readTargetSha256).toBeUndefined();
    });
    it("publishes the pending origin after its delayed complete input, retaining exact proof on every notice", () => {
      const s = setup();
      s.projector.tool({ ...origin, rawInput: {}, locations: undefined });
      expect(s.rows).toEqual([]);
      s.projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "read", rawInput: { path }, locations: [{ path }] });
      s.projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "read", status: "in_progress" });
      s.projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "read", status: "completed" });
      expect(s.rows.map(row => [row.status, row.readTargetSha256])).toEqual([["pending", hash], ["in_progress", hash], ["completed", hash]]);
    });
  });
}
