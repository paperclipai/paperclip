import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRuntimeStartupState,
  readRuntimeStartupState,
  resolveRuntimeStartupStatePath,
  writeRuntimeStartupState,
} from "../runtime-startup-state.js";

describe("runtime startup state", () => {
  it("writes and reads the startup marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-runtime-startup-state-"));
    const file = path.join(dir, "startup-state.json");
    try {
      writeRuntimeStartupState(
        {
          pid: 123,
          phase: "migrating",
          startedAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:05:00.000Z",
          databaseLabel: "Embedded PostgreSQL",
        },
        file,
      );

      expect(readRuntimeStartupState(file)).toEqual({
        pid: 123,
        phase: "migrating",
        startedAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:05:00.000Z",
        databaseLabel: "Embedded PostgreSQL",
      });

      clearRuntimeStartupState(file);
      expect(readRuntimeStartupState(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the default home-relative path", () => {
    const resolved = resolveRuntimeStartupStatePath("");
    expect(resolved).toContain(path.join("Library", "Logs", "fragno", "paperclip-runtime-startup-state.json"));
  });
});
