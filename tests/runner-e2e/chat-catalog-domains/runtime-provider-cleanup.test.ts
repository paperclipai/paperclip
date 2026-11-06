import { expect, it } from "vitest";
import { matchesOwnedProvider } from "./runtime-provider-cleanup.js";
function fixture() {
  return { identity: { pid: 987654, parentPid: 987653, uid: 501, startedAt: "2026-10-26T12:00:01Z", executable: "/owned/bin/codex", digest: "a".repeat(64), appServer: true }, expected: { providerPid: 987654, providerStartedAt: "2026-10-26T12:00:01Z", runnerPid: 987653, uid: 501, runStartedAt: "2026-10-26T12:00:00Z" } };
}
it("qualifies only the exact checkpoint provider with the actual direct owned Runner parent", () => {
  expect(matchesOwnedProvider(fixture())).toBe(true);
  for (const patch of [{ pid: process.pid }, { pid: 987655 }, { parentPid: 987652 }, { uid: 502 }, { startedAt: "2026-10-26T11:00:00Z" }, { executable: "/owned/bin/unrelated" }, { digest: "unknown" }, { appServer: false }]) {
    const f = fixture(); expect(matchesOwnedProvider({ ...f, identity: { ...f.identity, ...patch } })).toBe(false);
  }
  const f = fixture(); f.expected.providerStartedAt = "2026-10-26T12:00:00Z"; expect(matchesOwnedProvider(f)).toBe(false);
});
function openCodeFixture() {
  const f = fixture();
  return { identity: { ...f.identity, executable: "/owned/bin/node", appServer: false, proxyScript: "/owned/runner/dist/cli/opencode-app-server-proxy.cjs", proxyDigest: "b".repeat(64) },
    expected: { ...f.expected, kind: "opencode" as const, executable: "/owned/bin/node", digest: "a".repeat(64), proxyScript: "/owned/runner/dist/cli/opencode-app-server-proxy.cjs", proxyDigest: "b".repeat(64) } };
}
it("qualifies the exact OpenCode protocol proxy rather than an SDK server or a Codex fallback", () => {
  expect(matchesOwnedProvider(openCodeFixture())).toBe(true);
  for (const patch of [{ executable: "/foreign/node" }, { proxyScript: "/foreign/opencode-app-server-proxy.cjs" }, { proxyDigest: "c".repeat(64) }, { digest: "c".repeat(64) }, { parentPid: 888888 }, { startedAt: "2026-10-26T11:00:00Z" }, { pid: 888888 }, { appServer: true }, { proxyScript: undefined }]) {
    const f = openCodeFixture(); expect(matchesOwnedProvider({ ...f, identity: { ...f.identity, ...patch } })).toBe(false);
  }
  const f = openCodeFixture(); expect(matchesOwnedProvider({ ...f, expected: { ...f.expected, proxyDigest: undefined } })).toBe(false);
  expect(matchesOwnedProvider({ ...f, identity: { ...f.identity, executable: "/owned/bin/opencode", proxyScript: undefined } })).toBe(false);
});
