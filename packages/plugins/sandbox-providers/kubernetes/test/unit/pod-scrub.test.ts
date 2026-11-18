import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execInPod: vi.fn() }));
vi.mock("../../src/pod-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-exec.js")>()),
  execInPod: h.execInPod,
}));

import { buildScrubScript, scrubPod } from "../../src/pod-scrub.js";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";

describe("buildScrubScript", () => {
  it("keeps PID 1, its sleep chain and itself alive, and kills everything else", () => {
    const script = buildScrubScript("/workspace");
    expect(script).toContain('[ "$pid" = "1" ] && continue');
    expect(script).toContain('[ "$pid" = "$self" ] && continue');
    // tini -- /bin/sh -c "sleep infinity": killing the sleep chain stops the container.
    expect(script).toContain('"sleep infinity "|"/bin/sh -c sleep infinity "');
    expect(script).toContain("kill -9");
  });

  it("removes the whole runtime tree and empties every writable scratch area, then verifies", () => {
    const script = buildScrubScript("/workspace");
    expect(script).toContain("rm -rf -- '/workspace/.paperclip-runtime'");
    expect(script).toContain("find /home/paperclip -mindepth 1 -maxdepth 1 ! -name .cache -exec rm -rf -- {} +");
    expect(script).toContain("find /home/paperclip/.cache -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +");
    expect(script).toContain("find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +");
    expect(script).toContain("find /dev/shm -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +");
    expect(script).toContain("[ ! -e '/workspace/.paperclip-runtime' ] &&");
    // The last command is the emptiness check, so a surviving file fails the scrub.
    expect(script.trim().split("\n").pop()).toContain("find /home/paperclip /home/paperclip/.cache /tmp /dev/shm");
  });

  it("quotes a hostile remote cwd and ignores a trailing slash", () => {
    const script = buildScrubScript("/work space/it's/");
    expect(script).toContain("'/work space/it'\\''s/.paperclip-runtime'");
  });

  it("covers every writable path of the pod, so the scrub is adapter-independent", () => {
    // The pod's root filesystem is read-only; its only writable volumes are
    // /workspace, /home/paperclip (+ .cache) and /tmp. If the pod spec ever gains
    // another writable mount, this fails and the scrub must be extended.
    const manifest = buildSandboxCrManifest({
      namespace: "ns", sandboxName: "pc-x", adapterType: "pi_local", image: "img", envSecretName: "s",
      serviceAccountName: "sa", labels: {}, resources: {}, runtimeClassName: undefined, imagePullSecrets: [],
    }) as { spec: { podTemplate: { spec: { containers: Array<{ securityContext: { readOnlyRootFilesystem: boolean }; volumeMounts: Array<{ mountPath: string }> }> } } } };
    const container = manifest.spec.podTemplate.spec.containers[0]!;
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.volumeMounts.map((m) => m.mountPath).sort()).toEqual(
      ["/home/paperclip", "/home/paperclip/.cache", "/tmp", "/workspace"],
    );
  });
});

describe("scrubPod", () => {
  it("reports ok on exit 0 and runs a plain sh -c (no env, no stdin)", async () => {
    h.execInPod.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    expect(await scrubPod({} as never, "ns", "pod", "/workspace")).toEqual({ ok: true, detail: "" });
    const args = h.execInPod.mock.calls[0];
    expect(args[1]).toBe("ns");
    expect(args[2]).toBe("pod");
    expect(args[4][0]).toBe("/bin/sh");
    expect(args[5]).toBeUndefined();
  });

  it("reports failure on a non-zero exit or an exec error", async () => {
    h.execInPod.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "rm: busy" });
    expect(await scrubPod({} as never, "ns", "pod", "/workspace")).toMatchObject({ ok: false });
    h.execInPod.mockRejectedValueOnce(new Error("socket closed"));
    expect(await scrubPod({} as never, "ns", "pod", "/workspace")).toEqual({ ok: false, detail: "socket closed" });
  });
});
