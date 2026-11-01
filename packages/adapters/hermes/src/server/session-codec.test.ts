import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

/**
 * TSMC-21089 / TSMC-21482 — hermes must round-trip `cwd` through the session codec.
 *
 * Why this test exists. `resolveRuntimeSessionParamsForWorkspace` rotates a saved
 * session away when a project workspace becomes available, and converges via:
 *
 *     if (previousCwd && previousCwd === projectCwd) { resume }
 *
 * That guard was added by TSMC-21089 precisely because the rotation was meant to
 * happen ONCE and was instead repeating forever ("78 of 183 (agent, issue) pairs
 * rotated more than once, worst 59 times ... burned 815,607 tokens").
 *
 * It only works if the adapter persists `cwd`. Hermes did not: the codec returned
 * `{ sessionId }` and dropped everything else on BOTH serialize and deserialize,
 * so `previousCwd` was always undefined and the guard could never fire.
 *
 * Measured live 2026-08-24 before this fix:
 *   - session rows carrying `cwd`: codex 145/145, claude 34/34, antigravity 26/26,
 *     hermes **0/17**
 *   - hermes runs resuming a saved session: **0 of 433** in 24h, including 207
 *     repeat visits to a card the lane had already worked
 *   - every repeat visit recorded `taskSessionAvailable=true` with
 *     `resetReasons: ["project_workspace_migration_from_fallback"]`
 *
 * The session was there. It was thrown away every single run.
 */
describe("hermes sessionCodec cwd round-trip (TSMC-21482)", () => {
  const CWD = "/Users/glad0s/.paperclip/instances/default/projects/abc/def/_default";

  it("preserves cwd through deserialize — the convergence guard reads this", () => {
    const out = sessionCodec.deserialize({ sessionId: "20260824_140755_a25b32", cwd: CWD });
    expect(out).not.toBeNull();
    expect(out?.sessionId).toBe("20260824_140755_a25b32");
    expect(out?.cwd).toBe(CWD);
  });

  it("preserves cwd through serialize — without this it is never persisted", () => {
    const out = sessionCodec.serialize({ sessionId: "20260824_140755_a25b32", cwd: CWD });
    expect(out).not.toBeNull();
    expect(out?.cwd).toBe(CWD);
  });

  it("survives a full serialize -> deserialize round trip", () => {
    const stored = sessionCodec.serialize({ sessionId: "20260824_140755_a25b32", cwd: CWD });
    const loaded = sessionCodec.deserialize(stored);
    expect(loaded?.cwd).toBe(CWD);
  });

  it("accepts the snake_case spellings the CLI may emit", () => {
    const out = sessionCodec.deserialize({ session_id: "20260824_140755_a25b32", workdir: CWD });
    expect(out?.sessionId).toBe("20260824_140755_a25b32");
    expect(out?.cwd).toBe(CWD);
  });

  it("still requires a sessionId, and still returns null without one", () => {
    expect(sessionCodec.deserialize({ cwd: CWD })).toBeNull();
    expect(sessionCodec.serialize({ cwd: CWD })).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("nope")).toBeNull();
  });

  it("omits cwd entirely when absent — no empty-string keys for the fingerprint to churn on", () => {
    const out = sessionCodec.deserialize({ sessionId: "20260824_140755_a25b32" });
    expect(out).toEqual({ sessionId: "20260824_140755_a25b32" });
    expect(Object.keys(out ?? {})).not.toContain("cwd");
  });

  it("getDisplayId is unchanged", () => {
    expect(sessionCodec.getDisplayId?.({ sessionId: "20260824_140755_a25b32", cwd: CWD }))
      .toBe("20260824_140755_a25b32");
  });
});
