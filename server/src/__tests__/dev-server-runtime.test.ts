import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPersistedDevServerRuntime,
  writePersistedDevServerRuntime,
} from "../dev-server-runtime.js";

const tempDirs: string[] = [];

function createTempRuntimeFilePath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-runtime-"));
  tempDirs.push(dir);
  return path.join(dir, "dev-server-runtime.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dev server runtime helpers", () => {
  it("writes and reads the selected listen port payload", () => {
    const filePath = createTempRuntimeFilePath();
    const env = { PAPERCLIP_DEV_SERVER_RUNTIME_FILE: filePath } as NodeJS.ProcessEnv;

    writePersistedDevServerRuntime(
      {
        requestedPort: 3100,
        listenPort: 3101,
        apiUrl: "http://localhost:3101",
        startedAt: "2026-04-13T16:55:00.000Z",
      },
      env,
    );

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      requestedPort: 3100,
      listenPort: 3101,
      apiUrl: "http://localhost:3101",
      startedAt: "2026-04-13T16:55:00.000Z",
    });
    expect(readPersistedDevServerRuntime(env)).toEqual({
      requestedPort: 3100,
      listenPort: 3101,
      apiUrl: "http://localhost:3101",
      startedAt: "2026-04-13T16:55:00.000Z",
    });
  });

  it("returns null for malformed runtime payloads", () => {
    const filePath = createTempRuntimeFilePath();
    const env = { PAPERCLIP_DEV_SERVER_RUNTIME_FILE: filePath } as NodeJS.ProcessEnv;

    writePersistedDevServerRuntime(
      {
        requestedPort: 0,
        listenPort: 3101,
        apiUrl: "http://localhost:3101",
        startedAt: "2026-04-13T16:55:00.000Z",
      },
      env,
    );

    expect(readPersistedDevServerRuntime(env)).toBeNull();
  });
});
