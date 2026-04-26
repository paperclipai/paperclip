import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreateState } from "./state.js";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "telemetry-state-test-"));
}

// ============================================================================
// loadOrCreateState — state file creation
// ============================================================================

describe("loadOrCreateState — file creation", () => {
  it("creates a state file when one does not exist", () => {
    const dir = makeTempDir();
    try {
      const state = loadOrCreateState(dir, "1.0.0");
      expect(existsSync(path.join(dir, "state.json"))).toBe(true);
      expect(state.installId).toBeTruthy();
      expect(state.salt).toBeTruthy();
      expect(state.firstSeenVersion).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the state directory recursively when it does not exist", () => {
    const base = makeTempDir();
    const nested = path.join(base, "a", "b", "c");
    try {
      loadOrCreateState(nested, "2.0.0");
      expect(existsSync(path.join(nested, "state.json"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns a state with a valid UUID installId", () => {
    const dir = makeTempDir();
    try {
      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a state with a 64-character hex salt", () => {
    const dir = makeTempDir();
    try {
      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.salt).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records createdAt as a valid ISO date string", () => {
    const dir = makeTempDir();
    try {
      const state = loadOrCreateState(dir, "1.0.0");
      expect(new Date(state.createdAt).getTime()).not.toBeNaN();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// loadOrCreateState — loading existing state
// ============================================================================

describe("loadOrCreateState — loading existing state", () => {
  it("loads an existing valid state file without modification", () => {
    const dir = makeTempDir();
    try {
      const existing = {
        installId: "existing-install-id",
        salt: "existing-salt-64chars-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        createdAt: "2025-01-01T00:00:00.000Z",
        firstSeenVersion: "0.9.0",
      };
      writeFileSync(path.join(dir, "state.json"), JSON.stringify(existing), "utf-8");

      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.installId).toBe("existing-install-id");
      expect(state.salt).toBe(existing.salt);
      expect(state.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(state.firstSeenVersion).toBe("0.9.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a new unique installId on each creation call", () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    try {
      const state1 = loadOrCreateState(dir1, "1.0.0");
      const state2 = loadOrCreateState(dir2, "1.0.0");
      expect(state1.installId).not.toBe(state2.installId);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("returns the same state on repeated calls to the same directory", () => {
    const dir = makeTempDir();
    try {
      const state1 = loadOrCreateState(dir, "1.0.0");
      const state2 = loadOrCreateState(dir, "2.0.0"); // version arg is ignored for existing state
      expect(state2.installId).toBe(state1.installId);
      expect(state2.salt).toBe(state1.salt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// loadOrCreateState — corrupted state recovery
// ============================================================================

describe("loadOrCreateState — corrupted state recovery", () => {
  it("recreates state when file contains invalid JSON", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(path.join(dir, "state.json"), "{not valid json", "utf-8");
      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.installId).toBeTruthy();
      expect(state.salt).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recreates state when installId field is missing", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({ salt: "some-salt", createdAt: "2025-01-01T00:00:00.000Z", firstSeenVersion: "1.0.0" }),
        "utf-8",
      );
      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.installId).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recreates state when salt field is missing", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({ installId: "id", createdAt: "2025-01-01T00:00:00.000Z", firstSeenVersion: "1.0.0" }),
        "utf-8",
      );
      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.salt).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recreates state when file is empty", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(path.join(dir, "state.json"), "", "utf-8");
      const state = loadOrCreateState(dir, "1.0.0");
      expect(state.installId).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
