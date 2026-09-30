import { expect, it } from "vitest";
import { validateAcpxRichEvent } from "./profile-extensions.js";
import { createCursorToolEvidence } from "./cursor-tool-evidence.js";

const initial = { type: "tool_call", tag: "tool_call", toolCallId: "tool", kind: "execute", status: "pending", rawInput: { command: "printf 'secret-canary' > '/fixture/denied.txt'" } };
const request = { raw: { sessionId: "session", toolCall: { toolCallId: "tool", kind: "execute" } } };
function setup(emit?: () => void) {
  const events: any[] = []; let active = true; let unavailable = false;
  const p = createCursorToolEvidence({ sessionId: "session", turnId: "turn", workingDirectory: "/fixture", active: () => active,
    emit: event => { validateAcpxRichEvent(event); emit?.(); events.push(event); }, unavailable: () => { unavailable = true; } });
  return { p, events, stop: () => { active = false; }, unavailable: () => unavailable, fields: () => events.map(e => Object.fromEntries(e.payload.details.map((d: any) => [d.name, d.value]))) };
}
it("correlates omitted permission input with the original command and records only its hash", () => {
  const s = setup(); s.p.tool(initial); const delivered = s.p.permission(request, "request", ["accept", "decline", "cancel"]);
  expect(s.fields().map(x => x.stage)).toEqual(["tool", "permission_requested"]);
  delivered!("reject_once"); delivered!("reject_once"); s.p.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "tool", status: "failed" });
  expect(s.fields().map(x => x.stage)).toEqual(["tool", "permission_requested", "permission_delivered", "tool"]);
  expect(new Set(s.fields().map(x => x.commandSha256)).size).toBe(1);
  expect(s.fields()[0].commandSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(s.events)).not.toContain("secret-canary");
});
it("waits for the original iterator event when permission arrives before the queued tool", () => {
  const s = setup(); const delivered = s.p.permission(request, "request", ["decline"]); expect(s.events).toHaveLength(0);
  s.p.tool(initial); delivered!("reject_once"); expect(s.fields().map(x => x.stage)).toEqual(["tool", "permission_requested", "permission_delivered"]);
});
it("cannot invent origin from permission or a terminal delta", () => {
  const s = setup(); const delivered = s.p.permission(request, "request", ["decline"]); delivered!("reject_once");
  s.p.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "tool", kind: "execute", status: "failed", rawInput: initial.rawInput }); expect(s.events).toHaveLength(0);
});
it.each(["foreign-session", "changed-command", "changed-kind", "reused-origin", "duplicate-permission"])("fails qualification closed for %s", variant => {
  const s = setup(); s.p.tool(initial);
  if (variant === "foreign-session") s.p.permission({ raw: { ...request.raw, sessionId: "foreign" } }, "request", ["decline"]);
  if (variant === "changed-command") s.p.permission({ raw: { ...request.raw, toolCall: { ...request.raw.toolCall, rawInput: { command: "different" } } } }, "request", ["decline"]);
  if (variant === "changed-kind") s.p.tool({ ...initial, tag: "tool_call_update", kind: "edit" });
  if (variant === "reused-origin") s.p.tool(initial);
  if (variant === "duplicate-permission") { s.p.permission(request, "request", ["decline"]); s.p.permission(request, "request2", ["decline"]); }
  expect(s.fields().at(-1).stage).toBe("evidence_incomplete"); expect(s.unavailable()).toBe(true);
});
it("ignores inactive turns and never lets observation errors undo a delivered decision", () => {
  const s = setup(); s.p.tool(initial); const delivered = s.p.permission(request, "request", ["decline"]); s.stop(); delivered!("reject_once"); expect(s.events).toHaveLength(2);
  let fail = false; const broken = setup(() => { if (fail) throw new Error("secret-canary"); }); broken.p.tool(initial);
  const callback = broken.p.permission(request, "request", ["decline"]); fail = true;
  expect(() => callback!("reject_once")).not.toThrow(); expect(broken.unavailable()).toBe(true);
});
it("bounds retained tool origins", () => {
  const s = setup(); for (let i = 0; i < 257; i++) s.p.tool({ ...initial, toolCallId: `tool-${i}` });
  expect(s.fields().at(-1).stage).toBe("evidence_incomplete"); expect(s.events).toHaveLength(257);
});

it("rejects commands missing from their original frame and bounded oversized input", () => {
  for (const command of [undefined, "x".repeat(64 * 1024 + 1)]) {
    const s = setup(); s.p.tool({ ...initial, rawInput: { command } });
    expect(s.fields().at(-1).stage).toBe("evidence_incomplete");
  }
});

it("preserves execute denial evidence after valid edit and read permission inputs", () => {
  const s = setup();
  for (const kind of ["edit", "read"]) {
    const call = { ...initial, toolCallId: kind, kind, rawInput: { path: "/fixture/source.txt", content: "non-command-canary" } };
    s.p.tool(call);
    const delivered = s.p.permission({ raw: { sessionId: "session", toolCall: call } }, `${kind}-request`, ["accept", "decline"]);
    expect(delivered).toBeTypeOf("function"); delivered!("allow_once");
    s.p.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: kind, status: "completed" });
  }
  s.p.tool(initial); s.p.permission(request, "request", ["decline"])!("reject_once");
  s.p.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "tool", status: "failed" });
  expect(s.unavailable()).toBe(false);
  expect(s.fields().some(row => row.stage === "evidence_incomplete")).toBe(false);
  expect(s.fields().filter(row => row.toolCallId !== "tool").every(row => row.commandSha256 === undefined)).toBe(true);
  expect(s.fields().filter(row => row.toolCallId === "read").every(row => row.operation === "read")).toBe(true);
  expect(s.fields().filter(row => row.toolCallId === "edit").every(row => row.operation === undefined)).toBe(true);
  const shell = s.fields().filter(row => row.toolCallId === "tool");
  expect(shell.map(row => row.stage)).toEqual(["tool", "permission_requested", "permission_delivered", "tool"]);
  expect(shell[2].outcome).toBe("reject_once"); expect(shell[3].status).toBe("failed");
  expect(new Set(shell.map(row => row.commandSha256)).size).toBe(1);
  expect(shell[0].commandSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(s.events)).not.toContain("non-command-canary");
});
it.each(["edit", "read", "unknown-native-kind"])("still rejects a contradictory permission kind %s", kind => {
  const s = setup(); s.p.tool(initial);
  s.p.permission({ raw: { sessionId: "session", toolCall: { toolCallId: "tool", kind, rawInput: { path: "/fixture/file" } } } }, "request", ["decline"]);
  expect(s.fields().at(-1).stage).toBe("evidence_incomplete"); expect(s.unavailable()).toBe(true);
});
