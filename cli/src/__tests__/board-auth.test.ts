import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearInvalidStoredBoardCredential,
  getStoredBoardCredential,
  readBoardAuthStore,
  removeStoredBoardCredential,
  setStoredBoardCredential,
  validateStoredBoardCredential,
} from "../client/board-auth.js";

function createTempAuthPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-auth-"));
  return path.join(dir, "auth.json");
}

describe("board auth store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty store when the file does not exist", () => {
    const authPath = createTempAuthPath();
    expect(readBoardAuthStore(authPath)).toEqual({
      version: 1,
      credentials: {},
    });
  });

  it("stores and retrieves credentials by normalized api base", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100/",
      token: "token-123",
      userId: "user-1",
      storePath: authPath,
    });

    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toMatchObject({
      apiBase: "http://localhost:3100",
      token: "token-123",
      userId: "user-1",
    });
  });

  it("removes stored credentials", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "token-123",
      storePath: authPath,
    });

    expect(removeStoredBoardCredential("http://localhost:3100", authPath)).toBe(true);
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });

  it("validates a cached credential against the current API", async () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "token-123",
      storePath: authPath,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            userId: "user-1",
            user: { id: "user-1", name: "Ada" },
            keyId: "key-1",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(validateStoredBoardCredential({
      apiBase: "http://localhost:3100",
      storePath: authPath,
    })).resolves.toMatchObject({
      status: "valid",
      userId: "user-1",
      userName: "Ada",
      keyId: "key-1",
    });
  });

  it("clears a stale cached credential when the current API rejects it", async () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "stale-token",
      storePath: authPath,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Board authentication required" }), { status: 401 }),
      ),
    );

    await expect(clearInvalidStoredBoardCredential({
      apiBase: "http://localhost:3100",
      storePath: authPath,
    })).resolves.toMatchObject({
      status: "invalid",
      removed: true,
    });
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });
});
