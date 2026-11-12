import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { sshPinnedHost } from "./runtime-private.js";
function valid() { const publicBytes = Buffer.from("synthetic public key bytes for pin calibration");
  return { hostname: "owned-fixture.invalid", port: "2200", login: "eval", allowedRemoteRoot: "/srv/paperclip-eval-disposable",
    knownHosts: `[owned-fixture.invalid]:2200 ssh-ed25519 ${publicBytes.toString("base64")}`,
    hostKeySha256: `SHA256:${createHash("sha256").update(publicBytes).digest("base64").replace(/=+$/, "")}` }; }
it("accepts only the exact provided owned host and matching known-host public-key pin", () => expect(sshPinnedHost(valid())).toBe(true));
it("rejects a key belonging to a different host", () => { const o = valid(); o.hostname = "other.invalid"; expect(sshPinnedHost(o)).toBe(false); });
it("rejects a mismatching public-key fingerprint", () => { const o = valid(); o.hostKeySha256 = "SHA256:wrong"; expect(sshPinnedHost(o)).toBe(false); });
it("rejects an unscoped remote filesystem root", () => { const o = valid(); o.allowedRemoteRoot = "/"; expect(sshPinnedHost(o)).toBe(false); });
it("rejects accepting multiple unbounded host identities", () => { const o = valid(); o.knownHosts += `\n${o.knownHosts}`; expect(sshPinnedHost(o)).toBe(false); });
