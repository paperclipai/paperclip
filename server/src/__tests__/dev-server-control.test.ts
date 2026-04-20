import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPersistedDevServerControl,
  readPersistedDevServerControl,
  writePersistedDevServerControl,
} from "../dev-server-control.js";

const tempDirs: string[] = [];

function createTempControlFilePath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-control-"));
  tempDirs.push(dir);
  return path.join(dir, "dev-server-control.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dev server control helpers", () => {
  it("writes and reads persisted restart requests", () => {
    const filePath = createTempControlFilePath();

    expect(
      writePersistedDevServerControl(
        {
          action: "restart",
          requestId: "req-1",
          requestedAt: "2026-04-20T12:00:00.000Z",
          requestedBy: "local-board",
        },
        { PAPERCLIP_DEV_SERVER_CONTROL_FILE: filePath },
      ),
    ).toBe(true);

    expect(readPersistedDevServerControl({ PAPERCLIP_DEV_SERVER_CONTROL_FILE: filePath })).toEqual({
      action: "restart",
      requestId: "req-1",
      requestedAt: "2026-04-20T12:00:00.000Z",
      requestedBy: "local-board",
    });
  });

  it("clears persisted restart requests", () => {
    const filePath = createTempControlFilePath();

    writePersistedDevServerControl(
      {
        action: "restart",
        requestId: "req-2",
        requestedAt: "2026-04-20T12:00:00.000Z",
        requestedBy: "local-board",
      },
      { PAPERCLIP_DEV_SERVER_CONTROL_FILE: filePath },
    );

    expect(clearPersistedDevServerControl({ PAPERCLIP_DEV_SERVER_CONTROL_FILE: filePath })).toBe(true);
    expect(readPersistedDevServerControl({ PAPERCLIP_DEV_SERVER_CONTROL_FILE: filePath })).toBeNull();
  });

  it("returns false when no control file is configured", () => {
    expect(
      writePersistedDevServerControl(
        {
          action: "restart",
          requestId: "req-3",
          requestedAt: "2026-04-20T12:00:00.000Z",
          requestedBy: "local-board",
        },
        {},
      ),
    ).toBe(false);
    expect(clearPersistedDevServerControl({})).toBe(false);
  });
});
