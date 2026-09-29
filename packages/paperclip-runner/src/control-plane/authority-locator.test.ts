import { closeSync, mkdtempSync, openSync, rmSync, truncateSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readDurableControlPlaneState } from "./authority-locator.js";
import { DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES } from "./durable-prp-control-plane.js";

it("preserves the existing legacy reader window when adding indexed locators", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "legacy-authority-window-"));
  const path = resolve(root, "control-plane-state.json");
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, '{"schema":"paperclip.runner.durable.control-plane-state.v1","history":"');
      const chunk = Buffer.alloc(1024 * 1024, "x");
      for (let index = 0; index < 65; index++) writeSync(fd, chunk);
      writeSync(fd, '"}');
    } finally { closeSync(fd); }
    // This valid compatibility file exceeds the accidental 64 MiB locator
    // reader cap, but is still inside the controller's original 192 MiB bound.
    const state = await readDurableControlPlaneState(root);
    expect((state.history as string).length).toBe(65 * 1024 * 1024);
    // A sparse oversized file is only a metadata-rejection fixture, not growth
    // qualification: the reader must reject it before allocating its body.
    truncateSync(path, DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES + 1);
    await expect(readDurableControlPlaneState(root)).rejects.toThrow("state_unsafe");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
