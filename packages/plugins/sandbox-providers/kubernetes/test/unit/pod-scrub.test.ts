import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execInPod: vi.fn() }));
vi.mock("../../src/pod-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-exec.js")>()),
  execInPod: h.execInPod,
}));

import { buildScrubScript, runtimeKeyForAdapter, scrubPod } from "../../src/pod-scrub.js";

describe("buildScrubScript", () => {
  it("keeps PID 1, its sleep chain and itself alive, and removes only the adapter's runtime dir and temp files", () => {
    const script = buildScrubScript("/workspace", "hermes_local");
    expect(script).toContain('[ "$pid" = "1" ] && continue');
    expect(script).toContain('[ "$pid" = "$self" ] && continue');
    // tini -- /bin/sh -c "sleep infinity": killing the sleep chain stops the container.
    expect(script).toContain('"sleep infinity "|"/bin/sh -c sleep infinity "');
    expect(script).toContain("kill -9");
    expect(script).toContain("rm -rf -- '/workspace/.paperclip-runtime/hermes'");
    expect(script).not.toContain("rm -rf -- '/workspace/.paperclip-runtime'\n");
    expect(script).toContain("rm -rf -- /tmp/*");
    // The scrub must fail loudly if the runtime dir survives.
    expect(script.trim().endsWith("[ ! -e '/workspace/.paperclip-runtime/hermes' ]")).toBe(true);
  });

  it("derives the runtime key from the adapter type", () => {
    expect(runtimeKeyForAdapter("hermes_local")).toBe("hermes");
    expect(runtimeKeyForAdapter("pi_local")).toBe("pi");
  });

  it("quotes a hostile remote cwd and ignores a trailing slash", () => {
    const script = buildScrubScript("/work space/it's/", "hermes_local");
    expect(script).toContain("'/work space/it'\\''s/.paperclip-runtime/hermes'");
  });
});

describe("scrubPod", () => {
  it("reports ok on exit 0 and runs a plain sh -c (no env, no stdin)", async () => {
    h.execInPod.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    expect(await scrubPod({} as never, "ns", "pod", "/workspace", "hermes_local")).toEqual({ ok: true, detail: "" });
    const args = h.execInPod.mock.calls[0];
    expect(args[1]).toBe("ns");
    expect(args[2]).toBe("pod");
    expect(args[4][0]).toBe("/bin/sh");
    expect(args[5]).toBeUndefined();
  });

  it("reports failure on a non-zero exit or an exec error", async () => {
    h.execInPod.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "rm: busy" });
    expect(await scrubPod({} as never, "ns", "pod", "/workspace", "hermes_local")).toMatchObject({ ok: false });
    h.execInPod.mockRejectedValueOnce(new Error("socket closed"));
    expect(await scrubPod({} as never, "ns", "pod", "/workspace", "hermes_local")).toEqual({
      ok: false,
      detail: "socket closed",
    });
  });
});
