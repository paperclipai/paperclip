import { expect, it, vi } from "vitest";
import { verifyHermesCommandSandbox } from "./hermes-installation.js";

it("rejects a Linux host that has bubblewrap but denies namespaces", async () => {
  const execute = vi.fn(async () => { throw new Error("Creating new namespace failed: Operation not permitted"); });
  await expect(verifyHermesCommandSandbox("linux", execute)).rejects.toThrow("cannot safely run Hermes command tools");
  expect(execute).toHaveBeenCalledWith("/usr/bin/bwrap", expect.arrayContaining(["--unshare-pid", "--proc", "/proc"]));
});

it("probes the macOS process policy before admitting a provider", async () => {
  const execute = vi.fn(async () => {});
  await verifyHermesCommandSandbox("darwin", execute);
  expect(execute).toHaveBeenCalledWith("/usr/bin/sandbox-exec", expect.arrayContaining(["/usr/bin/true"]));
});

it("checks usable Linux character devices before admitting credentials", async () => {
  const execute = vi.fn(async () => {});
  await verifyHermesCommandSandbox("linux", execute);
  expect(execute).toHaveBeenCalledWith("/usr/bin/bwrap", [
    "--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    "--", "/bin/sh", "-c", "test -c /dev/null && : < /dev/null && : > /dev/null",
  ]);
});

it("rejects a Linux host when the device probe fails", async () => {
  const execute = vi.fn(async () => { throw new Error("/dev/null: Permission denied"); });
  await expect(verifyHermesCommandSandbox("linux", execute)).rejects.toMatchObject({ code: "HERMES_HOST_SANDBOX_UNAVAILABLE" });
});
