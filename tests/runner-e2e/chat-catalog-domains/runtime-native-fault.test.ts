import { expect, it } from "vitest";
import { ownedNativeExecutablePath, matchesOwnedNativeIdentity, type NativeFaultBinding } from "./runtime-native-fault.js";
function valid() {
  return { identity: { pid: 940123, uid: 501, group: 940123, startedAt: "2026-10-26T12:00:00Z", executable: "/qualified/runnerd", commandRunId: "run", commandRunnerId: "runner", runtimeRoot: "/owned/attempt/state/runner" },
    run: { id: "run", companyId: "company", agentId: "morgan", status: "running", runtimeMode: "native", nativeIssueId: "website", runnerInstanceId: "runner", processPid: 940123, processGroupId: 940123, processStartedAt: new Date("2026-10-26T12:00:00.123Z") } as NativeFaultBinding,
    expected: { companyId: "company", agentId: "morgan", issueId: "website", uid: 501, executable: "/qualified/runnerd", root: "/owned/attempt" } };
}
it("accepts exact public native binding and separately observed owned process identity", () => expect(matchesOwnedNativeIdentity(valid())).toBe(true));
it.each(["uid", "pid", "group"] as const)("rejects mismatched %s", field => { const x = valid(); x.identity[field]++; expect(matchesOwnedNativeIdentity(x)).toBe(false); });
it.each(["commandRunId", "commandRunnerId", "executable", "runtimeRoot"] as const)("rejects foreign %s", field => { const x = valid(); x.identity[field] = "/other"; expect(matchesOwnedNativeIdentity(x)).toBe(false); });
it("rejects a sibling path sharing the attempt prefix", () => { const x = valid(); x.identity.runtimeRoot = "/owned/attempt-foreign/state"; expect(matchesOwnedNativeIdentity(x)).toBe(false); });
it("rejects PID reuse with changed start identity", () => { const x = valid(); x.identity.startedAt = "2026-10-26T13:00:00Z"; expect(matchesOwnedNativeIdentity(x)).toBe(false); });
it.each(["companyId", "agentId", "nativeIssueId"] as const)("rejects changed public run %s", field => { const x = valid(); x.run[field] = "foreign"; expect(matchesOwnedNativeIdentity(x)).toBe(false); });
it("rejects a missing retained process start", () => { const x = valid(); x.run.processStartedAt = null; expect(matchesOwnedNativeIdentity(x)).toBe(false); });

it("rejects terminal public run state", () => { const x = valid(); x.run.status = "succeeded"; expect(matchesOwnedNativeIdentity(x)).toBe(false); });
it("rejects legacy runtime", () => { const x = valid(); x.run.runtimeMode = "legacy"; expect(matchesOwnedNativeIdentity(x)).toBe(false); });

it("uses Linux kernel executable identity without trusting a ps basename, preserving absolute macOS paths", () => {
  expect(ownedNativeExecutablePath(987654, "node", "linux")).toBe("/proc/987654/exe");
  expect(ownedNativeExecutablePath(987654, "/owned/bin/runner", "darwin")).toBe("/owned/bin/runner");
  for (const platform of ["darwin", "win32"] as const) expect(() => ownedNativeExecutablePath(987654, "node", platform)).toThrow();
  for (const pid of [0, 1, process.pid, 12.5]) expect(() => ownedNativeExecutablePath(pid, "/owned/bin/runner", "linux")).toThrow();
});
