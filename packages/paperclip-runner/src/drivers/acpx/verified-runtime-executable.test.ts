import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  VERIFIED_RUNTIME_EXECUTABLE_ENV,
  verifiedRuntimeExecutable,
  verifiedRuntimeExecutableHandoff,
} from "./verified-runtime-executable.js";

describe("verified runtime executable", () => {
  it("preserves an inherited Linux descriptor for an explicit child handoff", () => {
    expect(
      verifiedRuntimeExecutable(
        { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/proc/self/fd/17" },
        "linux",
        4321,
        "/usr/bin/node",
      ),
    ).toBe("/proc/self/fd/17");
  });

  it("rejects a deleted live-process alias as a verified descendant runtime", () => {
    expect(() =>
      verifiedRuntimeExecutable(
        { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/proc/self/exe" },
        "linux",
        8765,
        "/usr/bin/node",
      ),
    ).toThrow("descriptor is invalid");
  });

  it("rejects ancestor descriptor paths at the verified boundary", () => {
    expect(() =>
      verifiedRuntimeExecutable(
        { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/proc/4321/fd/17" },
        "linux",
        8765,
        "/usr/bin/node",
      ),
    ).toThrow("descriptor is invalid");
  });

  it("rejects mutable Linux paths at the verified boundary", () => {
    expect(() =>
      verifiedRuntimeExecutable(
        { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/usr/bin/node" },
        "linux",
        4321,
        "/usr/bin/node",
      ),
    ).toThrow("descriptor is invalid");
  });

  it("uses process identity only when no verified runtime was supplied", () => {
    expect(verifiedRuntimeExecutable({}, "linux", 4321, "/usr/bin/node")).toBe(
      "/usr/bin/node",
    );
  });

  it("remaps the authenticated Linux descriptor into the child stdio table", () => {
    expect(
      verifiedRuntimeExecutableHandoff(
        29,
        { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/proc/self/fd/17" },
        "linux",
        4321,
        "/usr/bin/node",
      ),
    ).toEqual({
      executable: "/proc/self/fd/29",
      environmentValue: "/proc/self/fd/29",
      sourceFd: 17,
    });
  });

  it("does not invent a descriptor handoff for an ambient runtime", () => {
    expect(
      verifiedRuntimeExecutableHandoff(29, {}, "linux", 4321, "/usr/bin/node"),
    ).toEqual({
      executable: "/usr/bin/node",
      environmentValue: undefined,
      sourceFd: null,
    });
  });

  it("rejects standard and invalid child descriptor targets", () => {
    for (const targetFd of [-1, 0, 2, 3.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        verifiedRuntimeExecutableHandoff(
          targetFd,
          { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/proc/self/fd/17" },
          "linux",
          4321,
          "/usr/bin/node",
        ),
      ).toThrow("target descriptor is invalid");
    }
  });

  it.runIf(process.platform === "linux")(
    "keeps the authenticated runtime executable across two child generations",
    () => {
      const sourceFd = openSync(process.execPath, "r");
      try {
        const targetFd = 10;
        const handoff = verifiedRuntimeExecutableHandoff(
          targetFd,
          {
            [VERIFIED_RUNTIME_EXECUTABLE_ENV]: `/proc/self/fd/${sourceFd}`,
          },
          "linux",
        );
        const stdio: Array<"ignore" | "pipe" | number> = [
          "ignore",
          "pipe",
          "pipe",
        ];
        while (stdio.length < targetFd) stdio.push("ignore");
        stdio.push(handoff.sourceFd!);
        const child = spawnSync(
          handoff.executable,
          [
            "--eval",
            `const { spawnSync } = require("node:child_process");
const fd = ${targetFd};
const stdio = ["ignore", "pipe", "pipe"];
while (stdio.length < fd) stdio.push("ignore");
stdio.push(fd);
const nested = spawnSync("/proc/self/fd/" + fd, ["--eval", "process.stdout.write('nested-ok')"], { stdio });
if (nested.status !== 0) throw nested.error || new Error(nested.stderr.toString());
process.stdout.write(nested.stdout);`,
          ],
          {
            env: {
              [VERIFIED_RUNTIME_EXECUTABLE_ENV]: handoff.environmentValue!,
            },
            stdio,
            encoding: "utf8",
          },
        );
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        expect(child.stdout).toBe("nested-ok");
      } finally {
        closeSync(sourceFd);
      }
    },
  );

  it("accepts only the authenticated live process image on macOS", () => {
    expect(
      verifiedRuntimeExecutable(
        {
          [VERIFIED_RUNTIME_EXECUTABLE_ENV]:
            "/private/tmp/.paperclip-verified-executable/launch",
        },
        "darwin",
        4321,
        "/private/tmp/.paperclip-verified-executable/launch",
      ),
    ).toBe("/private/tmp/.paperclip-verified-executable/launch");
  });

  it("rejects a different environment-supplied executable on macOS", () => {
    expect(() =>
      verifiedRuntimeExecutable(
        { [VERIFIED_RUNTIME_EXECUTABLE_ENV]: "/tmp/attacker/node" },
        "darwin",
        4321,
        "/private/tmp/.paperclip-verified-executable/launch",
      ),
    ).toThrow("path is invalid");
  });
});
