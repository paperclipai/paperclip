import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRuntimeInfo,
  removeRuntimeInfoForPid,
  writeRuntimeInfo,
  type PaperclipRuntimeInfo,
} from "../runtime-info.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { filePath: string; info: PaperclipRuntimeInfo } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-runtime-info-"));
  roots.push(root);
  return {
    filePath: path.join(root, "runtime-info.json"),
    info: {
      schemaVersion: 1,
      instanceId: "default",
      pid: 123,
      host: "127.0.0.1",
      port: 3101,
      dashboardUrl: "http://127.0.0.1:3101",
      startedAt: "2026-08-25T00:00:00.000Z",
    },
  };
}

describe("runtime info", () => {
  it("writes and reads the selected runtime endpoint", () => {
    const { filePath, info } = fixture();
    writeRuntimeInfo(info, filePath);
    expect(readRuntimeInfo("default", filePath)).toEqual(info);
  });

  it("does not remove runtime info owned by a replacement process", () => {
    const { filePath, info } = fixture();
    writeRuntimeInfo(info, filePath);
    removeRuntimeInfoForPid(999, "default", filePath);
    expect(readRuntimeInfo("default", filePath)).toEqual(info);
    removeRuntimeInfoForPid(info.pid, "default", filePath);
    expect(readRuntimeInfo("default", filePath)).toBeNull();
  });

  it("rejects malformed runtime info", () => {
    const { filePath } = fixture();
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, port: 70_000 }));
    expect(readRuntimeInfo("default", filePath)).toBeNull();
  });
});
