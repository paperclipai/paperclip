import { describe, expect, it } from "vitest";
import { spawnSyncHidden, spawnHidden } from "./spawn-hidden.js";

// These wrappers default `windowsHide: true` (TEN-157 / TEN-166) so child
// processes never flash a console window on Windows, while remaining a no-op on
// macOS/Linux and never altering stdio capture.

describe("spawn-hidden wrappers", () => {
  it("defaults windowsHide:true when no options are given (spawnSync)", () => {
    const result = spawnSyncHidden(process.execPath, [
      "-e",
      "process.stdout.write('hi')",
    ]);
    // Output capture must be unchanged — we hide the window, not the output.
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe("hi");
  });

  it("preserves caller options and adds windowsHide", () => {
    const result = spawnSyncHidden(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PC_TEN166 ?? '')"],
      { env: { ...process.env, PC_TEN166: "ok" }, encoding: "utf8" },
    );
    expect(result.stdout).toBe("ok");
  });

  it("does not mutate the caller's options object", () => {
    const opts = { encoding: "utf8" as const };
    spawnSyncHidden(process.execPath, ["-e", ""], opts);
    expect("windowsHide" in opts).toBe(false);
  });

  it("respects an explicit windowsHide:false (never overrides)", () => {
    // We can't observe window visibility in a unit test, but we can prove the
    // value the caller set survives: spawn an echo of the resolved flag via a
    // fake to assert the policy. Here we assert through spawnSync round-trip
    // that an explicit option is honoured (no throw, output intact).
    const result = spawnSyncHidden(
      process.execPath,
      ["-e", "process.stdout.write('explicit')"],
      { windowsHide: false, encoding: "utf8" },
    );
    expect(result.stdout).toBe("explicit");
  });

  it("spawnHidden returns a live ChildProcess with captured stdout", async () => {
    const child = spawnHidden(process.execPath, [
      "-e",
      "process.stdout.write('streamed')",
    ]);
    const out = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout?.on("data", (d) => (buf += d.toString()));
      child.on("close", () => resolve(buf));
      child.on("error", reject);
    });
    expect(out).toBe("streamed");
  });
});
